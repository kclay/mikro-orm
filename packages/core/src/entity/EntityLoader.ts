import type { AnyEntity, Dictionary, EntityMetadata, EntityProperty, FilterQuery, PopulateOptions, Primary, ConnectionType } from '../typings';
import type { EntityManager } from '../EntityManager';
import { QueryHelper } from '../utils/QueryHelper';
import { Utils } from '../utils/Utils';
import { ValidationError } from '../errors';
import type { Collection } from './Collection';
import type { LockMode, QueryOrderMap, PopulateHint } from '../enums';
import { LoadStrategy, QueryOrder, ReferenceType } from '../enums';
import { Reference } from './Reference';
import type { EntityField, FindOptions } from '../drivers/IDatabaseDriver';
import type { MetadataStorage } from '../metadata/MetadataStorage';
import type { Platform } from '../platforms/Platform';

export type EntityLoaderOptions<T, P extends string = never> = {
  where?: FilterQuery<T>;
  populateWhere?: PopulateHint;
  fields?: readonly EntityField<T, P>[];
  orderBy?: QueryOrderMap<T> | QueryOrderMap<T>[];
  refresh?: boolean;
  validate?: boolean;
  lookup?: boolean;
  convertCustomTypes?: boolean;
  ignoreLazyScalarProperties?: boolean;
  filters?: Dictionary<boolean | Dictionary> | string[] | boolean;
  strategy?: LoadStrategy;
  lockMode?: Exclude<LockMode, LockMode.OPTIMISTIC>;
  schema?: string;
  connectionType?: ConnectionType;
};

export class EntityLoader {

  private readonly metadata = this.em.getMetadata();
  private readonly driver = this.em.getDriver();

  constructor(private readonly em: EntityManager) { }

  /**
   * Loads specified relations in batch. This will execute one query for each relation, that will populate it on all of the specified entities.
   */
  async populate<T extends AnyEntity<T>, P extends string = never>(entityName: string, entities: T[], populate: PopulateOptions<T>[] | boolean, options: EntityLoaderOptions<T, P>): Promise<void> {
    if (entities.length === 0 || Utils.isEmpty(populate)) {
      return;
    }

    if (entities.some(e => !e.__helper)) {
      const entity = entities.find(e => !Utils.isEntity(e));
      const meta = this.metadata.find(entityName)!;
      throw ValidationError.notDiscoveredEntity(entity, meta, 'populate');
    }

    options.where ??= {} as FilterQuery<T>;
    options.orderBy ??= {};
    options.filters ??= {};
    options.lookup ??= true;
    options.validate ??= true;
    options.refresh ??= false;
    options.convertCustomTypes ??= true;
    populate = this.normalizePopulate<T>(entityName, populate as true, options.strategy, options.lookup);
    const invalid = populate.find(({ field }) => !this.em.canPopulate(entityName, field));

    /* istanbul ignore next */
    if (options.validate && invalid) {
      throw ValidationError.invalidPropertyName(entityName, invalid.field);
    }

    entities.forEach(e => e.__helper!.__serializationContext.populate = e.__helper!.__serializationContext.populate ?? populate as PopulateOptions<T>[]);

    for (const pop of populate) {
      await this.populateField<T>(entityName, entities, pop, options as Required<EntityLoaderOptions<T>>);
    }
  }

  normalizePopulate<T>(entityName: string, populate: PopulateOptions<T>[] | true, strategy?: LoadStrategy, lookup = true): PopulateOptions<T>[] {
    if (populate === true || populate.some(p => p.all)) {
      populate = this.lookupAllRelationships(entityName);
    } else {
      populate = Utils.asArray(populate);
    }

    if (lookup) {
      populate = this.lookupEagerLoadedRelationships(entityName, populate, strategy);
    }

    // convert nested `field` with dot syntax to PopulateOptions with children array
    populate.forEach(p => {
      if (!p.field.includes('.')) {
        return;
      }

      const [f, ...parts] = p.field.split('.');
      p.field = f;
      p.children = p.children || [];
      const prop = this.metadata.find(entityName)!.properties[f];
      p.strategy ??= prop.strategy;
      p.children.push(this.expandNestedPopulate(prop.type, parts, p.strategy, p.all));
    });

    // merge same fields
    return this.mergeNestedPopulate(populate);
  }

  /**
   * merge multiple populates for the same entity with different children
   */
  private mergeNestedPopulate<T>(populate: PopulateOptions<T>[]): PopulateOptions<T>[] {
    const tmp = populate.reduce((ret, item) => {
      if (!ret[item.field]) {
        ret[item.field] = item;
        return ret;
      }

      if (!ret[item.field].children && item.children) {
        ret[item.field].children = item.children;
      } else if (ret[item.field].children && item.children) {
        ret[item.field].children!.push(...item.children!);
      }

      return ret;
    }, {} as Dictionary<PopulateOptions<T>>);

    return Object.values(tmp).map(item => {
      if (item.children) {
        item.children = this.mergeNestedPopulate<T>(item.children);
      }

      return item;
    });
  }

  /**
   * Expands `books.perex` like populate to use `children` array instead of the dot syntax
   */
  private expandNestedPopulate<T>(entityName: string, parts: string[], strategy?: LoadStrategy, all?: boolean): PopulateOptions<T> {
    const meta = this.metadata.find(entityName)!;
    const field = parts.shift()!;
    const prop = meta.properties[field];
    const ret = { field, strategy, all } as PopulateOptions<T>;

    if (parts.length > 0) {
      ret.children = [this.expandNestedPopulate(prop.type, parts, strategy)];
    }

    return ret;
  }

  /**
   * preload everything in one call (this will update already existing references in IM)
   */
  private async populateMany<T extends AnyEntity<T>>(entityName: string, entities: T[], populate: PopulateOptions<T>, options: Required<EntityLoaderOptions<T>>): Promise<AnyEntity[]> {
    const field = populate.field as keyof T;
    const meta = this.metadata.find<T>(entityName)!;
    const prop = meta.properties[field as string] as EntityProperty;

    if (prop.reference === ReferenceType.SCALAR && prop.lazy) {
      const filtered = entities.filter(e => options.refresh || e[prop.name] === undefined);

      if (options.ignoreLazyScalarProperties || filtered.length === 0) {
        return entities;
      }

      const pk = Utils.getPrimaryKeyHash(meta.primaryKeys);
      const ids = Utils.unique(filtered.map(e => Utils.getPrimaryKeyValues(e, meta.primaryKeys, true)));
      const where = this.mergePrimaryCondition(ids, pk, options, meta, this.metadata, this.driver.getPlatform());
      const { filters, convertCustomTypes, lockMode, strategy, populateWhere, connectionType } = options;

      await this.em.find(meta.className, where, {
        filters, convertCustomTypes, lockMode, strategy, populateWhere, connectionType,
        fields: [prop.name] as never,
        populate: [],
      });

      return entities;
    }

    if (prop.reference === ReferenceType.EMBEDDED) {
      return [];
    }

    // set populate flag
    entities.forEach(entity => {
      const value = entity[field];

      if (Utils.isEntity(value, true)) {
        (value as AnyEntity).__helper!.populated();
      } else if (Utils.isCollection(value)) {
        value.populated();
      }
    });

    const filtered = this.filterCollections<T>(entities, field, options.refresh);
    const innerOrderBy = Utils.asArray(options.orderBy)
      .filter(orderBy => Utils.isObject(orderBy[prop.name]))
      .map(orderBy => orderBy[prop.name]);

    if (prop.reference === ReferenceType.MANY_TO_MANY && this.driver.getPlatform().usesPivotTable()) {
      return this.findChildrenFromPivotTable<T>(filtered, prop, options, innerOrderBy, populate);
    }

    const where = await this.extractChildCondition(options, prop);
    const data = await this.findChildren<T>(entities, prop, populate, { ...options, where, orderBy: innerOrderBy! });
    this.initializeCollections<T>(filtered, prop, field, data);

    return data;
  }

  private initializeCollections<T extends AnyEntity<T>>(filtered: T[], prop: EntityProperty, field: keyof T, children: AnyEntity[]): void {
    if (prop.reference === ReferenceType.ONE_TO_MANY) {
      this.initializeOneToMany<T>(filtered, children, prop, field);
    }

    if (prop.reference === ReferenceType.MANY_TO_MANY && !prop.owner && !this.driver.getPlatform().usesPivotTable()) {
      this.initializeManyToMany<T>(filtered, children, prop, field);
    }
  }

  private initializeOneToMany<T extends AnyEntity<T>>(filtered: T[], children: AnyEntity[], prop: EntityProperty, field: keyof T): void {
    for (const entity of filtered) {
      const items = children.filter(child => {
        if (prop.targetMeta!.properties[prop.mappedBy].mapToPk) {
          return child[prop.mappedBy] as unknown === entity.__helper!.getPrimaryKey();
        }

        return Reference.unwrapReference(child[prop.mappedBy]) as unknown === entity;
      });

      (entity[field] as unknown as Collection<AnyEntity>).hydrate(items);
    }
  }

  private initializeManyToMany<T extends AnyEntity<T>>(filtered: T[], children: AnyEntity[], prop: EntityProperty, field: keyof T): void {
    for (const entity of filtered) {
      const items = children.filter(child => (child[prop.mappedBy] as unknown as Collection<AnyEntity>).contains(entity));
      (entity[field] as unknown as Collection<AnyEntity>).hydrate(items, true);
    }
  }

  private async findChildren<T extends AnyEntity<T>>(entities: T[], prop: EntityProperty<T>, populate: PopulateOptions<T>, options: Required<EntityLoaderOptions<T>>): Promise<AnyEntity[]> {
    const children = this.getChildReferences<T>(entities, prop, options.refresh);
    const meta = this.metadata.find(prop.type)!;
    let fk = Utils.getPrimaryKeyHash(meta.primaryKeys);
    let schema: string | undefined = options.schema;

    if (prop.reference === ReferenceType.ONE_TO_MANY || (prop.reference === ReferenceType.MANY_TO_MANY && !prop.owner)) {
      fk = meta.properties[prop.mappedBy].name;
    }

    if (prop.reference === ReferenceType.ONE_TO_ONE && !prop.owner && populate.strategy !== LoadStrategy.JOINED && !this.em.config.get('autoJoinOneToOneOwner')) {
      children.length = 0;
      fk = meta.properties[prop.mappedBy].name;
      children.push(...this.filterByReferences(entities, prop.name, options.refresh));
    }

    if (children.length === 0) {
      return [];
    }

    if (!schema && [ReferenceType.ONE_TO_ONE, ReferenceType.MANY_TO_ONE].includes(prop.reference)) {
      schema = children.find(e => e.__helper!.__schema)?.__helper!.__schema;
    }

    const ids = Utils.unique(children.map(e => Utils.getPrimaryKeyValues(e, e.__meta!.primaryKeys, true)));
    const where = this.mergePrimaryCondition<T>(ids, fk, options, meta, this.metadata, this.driver.getPlatform());
    const fields = this.buildFields(options.fields, prop);
    const { refresh, filters, convertCustomTypes, lockMode, strategy, populateWhere, connectionType } = options;

    return this.em.find(prop.type, where, {
      refresh, filters, convertCustomTypes, lockMode, populateWhere,
      orderBy: [...Utils.asArray(options.orderBy), ...Utils.asArray(prop.orderBy), { [fk]: QueryOrder.ASC }] as QueryOrderMap<T>[],
      populate: populate.children as never ?? populate.all ?? [],
      strategy, fields, schema, connectionType,
    });
  }

  private mergePrimaryCondition<T>(ids: T[], pk: string, options: EntityLoaderOptions<T>, meta: EntityMetadata, metadata: MetadataStorage, platform: Platform): FilterQuery<T> {
    const cond1 = QueryHelper.processWhere({ where: { [pk]: { $in: ids } }, entityName: meta.name!, metadata, platform, convertCustomTypes: !options.convertCustomTypes });

    return options.where![pk]
      ? { $and: [cond1, options.where] } as FilterQuery<any>
      : { ...cond1, ...(options.where as Dictionary) };
  }

  private async populateField<T extends AnyEntity<T>>(entityName: string, entities: T[], populate: PopulateOptions<T>, options: Required<EntityLoaderOptions<T>>): Promise<void> {
    const prop = this.metadata.find(entityName)!.properties[populate.field] as EntityProperty<T>;

    if (prop.reference === ReferenceType.SCALAR && !prop.lazy) {
      return;
    }

    if (!populate.children) {
      return void await this.populateMany<T>(entityName, entities, populate, options);
    }

    await this.populateMany<T>(entityName, entities, populate, options);
    const children: T[] = [];

    for (const entity of entities) {
      if (Utils.isEntity(entity[populate.field])) {
        children.push(entity[populate.field]);
      } else if (Reference.isReference(entity[populate.field])) {
        children.push(entity[populate.field].unwrap());
      } else if (Utils.isCollection(entity[populate.field])) {
        children.push(...entity[populate.field].getItems());
      } else if (entity[populate.field] && prop.reference === ReferenceType.EMBEDDED) {
        children.push(...Utils.asArray(entity[populate.field]));
      }
    }

    const filtered = Utils.unique(children);
    const fields = this.buildFields(options.fields, prop);
    const innerOrderBy = Utils.asArray(options.orderBy)
      .filter(orderBy => Utils.isObject(orderBy[prop.name as string]))
      .map(orderBy => orderBy[prop.name as string]);
    const { refresh, filters, ignoreLazyScalarProperties, populateWhere, connectionType } = options;

    await this.populate<T>(prop.type, filtered, populate.children, {
      where: await this.extractChildCondition(options, prop, false) as FilterQuery<T>,
      orderBy: innerOrderBy as QueryOrderMap<T>[],
      fields,
      validate: false,
      lookup: false,
      refresh,
      filters,
      ignoreLazyScalarProperties,
      populateWhere,
      connectionType,
    });
  }

  private async findChildrenFromPivotTable<T extends AnyEntity<T>>(filtered: T[], prop: EntityProperty<T>, options: Required<EntityLoaderOptions<T>>, orderBy?: QueryOrderMap<T>[], populate?: PopulateOptions<T>): Promise<AnyEntity[]> {
    const ids = filtered.map((e: AnyEntity<T>) => e.__helper!.__primaryKeys);
    const refresh = options.refresh;
    const where = await this.extractChildCondition(options, prop, true);
    const fields = this.buildFields(options.fields, prop);
    const options2 = { ...options } as FindOptions<T>;
    delete options2.limit;
    delete options2.offset;
    options2.fields = fields;
    options2.populate = (populate?.children ?? []) as never;

    if (prop.customType) {
      ids.forEach((id, idx) => ids[idx] = QueryHelper.processCustomType<T>(prop, id as FilterQuery<T>, this.driver.getPlatform()) as Primary<T>[]);
    }

    const map = await this.driver.loadFromPivotTable(prop, ids, where, orderBy, this.em.getTransactionContext(), options2);
    const children: AnyEntity[] = [];

    for (const entity of filtered) {
      const items = map[entity.__helper!.getSerializedPrimaryKey()].map(item => {
        const entity = this.em.getEntityFactory().create<T>(prop.type, item, {
          refresh,
          merge: true,
          convertCustomTypes: true,
          schema: options.schema ?? this.em.config.get('schema'),
        });
        return this.em.getUnitOfWork().registerManaged<T>(entity, item, { refresh, loaded: true });
      });
      (entity[prop.name] as unknown as Collection<AnyEntity>).hydrate(items, true);
      children.push(...items);
    }

    return children;
  }

  private async extractChildCondition<T>(options: Required<EntityLoaderOptions<T>>, prop: EntityProperty<T>, filters = false) {
    const subCond = Utils.isPlainObject(options.where[prop.name as string]) ? options.where[prop.name as string] : {};
    const meta2 = this.metadata.find(prop.type)!;
    const pk = Utils.getPrimaryKeyHash(meta2.primaryKeys);

    ['$and', '$or'].forEach(op => {
      if (options.where[op]) {
        const child = options.where[op]
          .map((cond: Dictionary) => cond[prop.name])
          .filter((sub: unknown) => sub != null && !(Utils.isPlainObject(sub) && Object.keys(sub).every(key => Utils.isOperator(key, false))))
          .map((cond: Dictionary) => {
            if (Utils.isPrimaryKey(cond)) {
              return { [pk]: cond };
            }

            return cond;
          });

        if (child.length > 0) {
          subCond[op] = child;
        }
      }
    });

    const operators = Object.keys(subCond).filter(key => Utils.isOperator(key, false));

    if (operators.length > 0) {
      operators.forEach(op => {
        subCond[pk] ??= {};
        subCond[pk][op] = subCond[op];
        delete subCond[op];
      });
    }

    if (filters) {
      return this.em.applyFilters(prop.type, subCond, options.filters, 'read');
    }

    return subCond;
  }

  private buildFields<T, P extends string>(fields: readonly EntityField<T, P>[] = [], prop: EntityProperty<T>): readonly EntityField<T>[] | undefined {
    const ret = fields.reduce((ret, f) => {
      if (Utils.isPlainObject(f)) {
        Object.keys(f)
          .filter(ff => ff === prop.name)
          .forEach(ff => ret.push(...f[ff] as EntityField<T>[]));
      } else if (f.toString().includes('.')) {
        const parts = f.toString().split('.');
        const propName = parts.shift();
        const childPropName = parts.join('.') as EntityField<T>;

        /* istanbul ignore else */
        if (propName === prop.name) {
          ret.push(childPropName);
        }
      }

      return ret;
    }, [] as EntityField<T>[]);

    if (ret.length === 0) {
      return undefined;
    }

    // we need to automatically select the FKs too, e.g. for 1:m relations to be able to wire them with the items
    if (prop.reference === ReferenceType.ONE_TO_MANY) {
      const owner = prop.targetMeta!.properties[prop.mappedBy] as EntityProperty<T>;

      if (!ret.includes(owner.name)) {
        ret.push(owner.name);
      }
    }

    return ret;
  }

  private getChildReferences<T extends AnyEntity<T>>(entities: T[], prop: EntityProperty<T>, refresh: boolean): AnyEntity[] {
    const filtered = this.filterCollections(entities, prop.name, refresh);
    const children: AnyEntity[] = [];

    if (prop.reference === ReferenceType.ONE_TO_MANY) {
      children.push(...filtered.map(e => (e[prop.name] as unknown as Collection<T>).owner));
    } else if (prop.reference === ReferenceType.MANY_TO_MANY && prop.owner) {
      children.push(...filtered.reduce((a, b) => [...a, ...(b[prop.name] as unknown as Collection<AnyEntity>).getItems()], [] as AnyEntity[]));
    } else if (prop.reference === ReferenceType.MANY_TO_MANY) { // inverse side
      children.push(...filtered);
    } else { // MANY_TO_ONE or ONE_TO_ONE
      children.push(...this.filterReferences(entities, prop.name, refresh));
    }

    return children;
  }

  private filterCollections<T extends AnyEntity<T>>(entities: T[], field: keyof T, refresh: boolean): T[] {
    if (refresh) {
      return entities.filter(e => e[field]);
    }

    return entities.filter(e => Utils.isCollection(e[field]) && !(e[field] as unknown as Collection<AnyEntity>).isInitialized(true));
  }

  private filterReferences<T extends AnyEntity<T>>(entities: T[], field: keyof T, refresh: boolean): T[keyof T][] {
    const children = entities.filter(e => Utils.isEntity(e[field], true));

    if (refresh) {
      return children.map(e => Reference.unwrapReference(e[field]));
    }

    return children.filter(e => !(e[field] as AnyEntity).__helper!.__initialized).map(e => Reference.unwrapReference(e[field]));
  }

  private filterByReferences<T extends AnyEntity<T>>(entities: T[], field: keyof T, refresh: boolean): T[] {
    /* istanbul ignore next */
    if (refresh) {
      return entities;
    }

    return entities.filter(e => !(e[field] as AnyEntity)?.__helper?.__initialized);
  }

  private lookupAllRelationships<T>(entityName: string): PopulateOptions<T>[] {
    const ret: PopulateOptions<T>[] = [];
    const meta = this.metadata.find(entityName)!;

    meta.relations.forEach(prop => {
      ret.push({
        field: this.getRelationName(meta, prop),
        // force select-in strategy when populating all relations as otherwise we could cause infinite loops when self-referencing
        strategy: LoadStrategy.SELECT_IN,
        // no need to look up populate children recursively as we just pass `all: true` here
        all: true,
      });
    });

    return ret;
  }

  private getRelationName(meta: EntityMetadata, prop: EntityProperty): string {
    if (!prop.embedded) {
      return prop.name;
    }

    return `${this.getRelationName(meta, meta.properties[prop.embedded[0]])}.${prop.embedded[1]}`;
  }

  private lookupEagerLoadedRelationships<T>(entityName: string, populate: PopulateOptions<T>[], strategy?: LoadStrategy, prefix = '', visited: string[] = []): PopulateOptions<T>[] {
    const meta = this.metadata.find(entityName);

    if (visited.includes(entityName) || !meta) {
      return populate;
    }

    visited.push(entityName);
    const ret: PopulateOptions<T>[] = prefix === '' ? [...populate] : [];

    meta.relations
      .filter(prop => prop.eager || populate.some(p => p.field === prop.name))
      .forEach(prop => {
        const field = this.getRelationName(meta, prop);
        const prefixed = prefix ? `${prefix}.${field}` : field;
        const nestedPopulate = populate.find(p => p.field === prop.name)?.children ?? [];
        const nested = this.lookupEagerLoadedRelationships(prop.type, nestedPopulate, strategy, prefixed, visited.slice());

        if (nested.length > 0) {
          ret.push(...nested);
        } else {
          ret.push({
            field: prefixed,
            strategy: strategy ?? prop.strategy,
          });
        }
      });

    return ret;
  }

}
