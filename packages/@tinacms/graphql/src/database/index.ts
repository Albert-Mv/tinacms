/**
Copyright 2021 Forestry.io Holdings, Inc.
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at
    http://www.apache.org/licenses/LICENSE-2.0
Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import path from 'path'
import type { DocumentNode } from 'graphql'
import { GraphQLError } from 'graphql'
import { createSchema } from '../schema/createSchema'
import { atob, btoa, lastItem, sequential } from '../util'
import { normalizePath, parseFile, stringifyFile } from './util'
import type {
  CollectionFieldsWithNamespace,
  CollectionTemplatesWithNamespace,
  TinaCloudSchemaBase,
  TinaFieldInner,
  TinaSchema,
} from '@tinacms/schema-tools'
import type { Bridge } from './bridge'
import { TinaFetchError, TinaQueryError } from '../resolver/error'
import {
  BinaryFilter,
  coerceFilterChainOperands,
  DEFAULT_COLLECTION_SORT_KEY,
  DEFAULT_NUMERIC_LPAD,
  IndexDefinition,
  makeFilter,
  makeFilterSuffixes,
  makeIndexOpsForDocument,
  TernaryFilter,
} from './datalayer'
import {
  BatchOp,
  DelOp,
  INDEX_KEY_FIELD_SEPARATOR,
  Level,
  PutOp,
  ROOT_PREFIX,
  SUBLEVEL_OPTIONS,
} from './level'

type IndexStatusEvent = {
  status: 'inprogress' | 'complete' | 'failed'
  error?: Error
}
type IndexStatusCallback = (event: IndexStatusEvent) => Promise<void>

type CreateDatabase = {
  bridge: Bridge
  level: Level
  indexStatusCallback?: IndexStatusCallback
}

export const createDatabase = (config: CreateDatabase) => {
  return new Database({
    ...config,
    bridge: config.bridge,
    level: config.level,
  })
}
const SYSTEM_FILES = ['_schema', '_graphql', '_lookup']
const GENERATED_FOLDER = path.join('.tina', '__generated__')

/** Options for {@link Database.query} **/
export type QueryOptions = {
  fileExtension?: string
  /* collection name */
  collection: string
  /* filters to apply to the query */
  filterChain?: (BinaryFilter | TernaryFilter)[]
  /* sort (either field or index) */
  sort?: string
  /* limit results to first N items */
  first?: number
  /* limit results to last N items */
  last?: number
  /* specify cursor to start results at */
  after?: string
  /* specify cursor to end results at */
  before?: string
}

const defaultStatusCallback: IndexStatusCallback = () => Promise.resolve()

export class Database {
  public bridge: Bridge
  public level: Level
  public indexStatusCallback: IndexStatusCallback | undefined
  private tinaSchema: TinaSchema | undefined
  private collectionIndexDefinitions:
    | Record<string, Record<string, IndexDefinition>>
    | undefined
  private _lookup: { [returnType: string]: LookupMapType } | undefined
  constructor(public config: CreateDatabase) {
    this.bridge = config.bridge
    this.level = config.level
    this.indexStatusCallback =
      config.indexStatusCallback || defaultStatusCallback
  }

  private collectionForPath = async (
    filepath: string
  ): Promise<
    | CollectionFieldsWithNamespace<true>
    | CollectionTemplatesWithNamespace<true>
    | undefined
  > => {
    const tinaSchema = await this.getSchema()
    return tinaSchema.getCollectionByFullPath(filepath)
  }

  private async partitionPathsByCollection(documentPaths: string[]) {
    const pathsByCollection: Record<string, string[]> = {}
    const nonCollectionPaths: string[] = []
    const collections: Record<
      string,
      | CollectionFieldsWithNamespace<true>
      | CollectionTemplatesWithNamespace<true>
    > = {}
    for (const documentPath of documentPaths) {
      const collection = await this.collectionForPath(documentPath)
      if (collection) {
        if (!pathsByCollection[collection.name]) {
          pathsByCollection[collection.name] = []
        }
        collections[collection.name] = collection
        pathsByCollection[collection.name].push(documentPath)
      } else {
        nonCollectionPaths.push(documentPath)
      }
    }
    return { pathsByCollection, nonCollectionPaths, collections }
  }

  public get = async <T extends object>(filepath: string): Promise<T> => {
    if (SYSTEM_FILES.includes(filepath)) {
      throw new Error(`Unexpected get for config file ${filepath}`)
    } else {
      const tinaSchema = await this.getSchema()
      const extension = path.extname(filepath)
      const contentObject = await this.level
        .sublevel<string, Record<string, any>>(ROOT_PREFIX, SUBLEVEL_OPTIONS)
        .get(normalizePath(filepath))
      if (!contentObject) {
        throw new GraphQLError(`Unable to find record ${filepath}`)
      }
      const templateName =
        hasOwnProperty(contentObject, '_template') &&
        typeof contentObject._template === 'string'
          ? contentObject._template
          : undefined
      const { collection, template } =
        tinaSchema.getCollectionAndTemplateByFullPath(filepath, templateName)
      const field = template.fields.find((field) => {
        if (field.type === 'string' || field.type === 'rich-text') {
          if (field.isBody) {
            return true
          }
        }
        return false
      })

      let data = contentObject
      if ((extension === '.md' || extension === '.mdx') && field) {
        if (hasOwnProperty(contentObject, '$_body')) {
          const { $_body, ...rest } = contentObject
          data = rest
          data[field.name] = $_body as object
        }
      }
      return {
        ...data,
        _collection: collection.name,
        _keepTemplateKey: !!collection.templates,
        _template: lastItem(template.namespace),
        _relativePath: filepath
          .replace(collection.path, '')
          .replace(/^\/|\/$/g, ''),
        _id: filepath,
      } as T
    }
  }

  public addPendingDocument = async (
    filepath: string,
    data: { [key: string]: unknown }
  ) => {
    const { stringifiedFile, payload } = await this.stringifyFile(
      filepath,
      data
    )
    const collection = await this.collectionForPath(filepath)
    let collectionIndexDefinitions
    if (collection) {
      const indexDefinitions = await this.getIndexDefinitions()
      collectionIndexDefinitions = indexDefinitions?.[collection.name]
    }
    const normalizedPath = normalizePath(filepath)
    await this.bridge.put(normalizedPath, stringifiedFile)

    const putOps = makeIndexOpsForDocument(
      normalizedPath,
      collection?.name,
      collectionIndexDefinitions,
      payload,
      'put',
      this.level
    )

    let existingItem
    try {
      existingItem = await this.level
        .sublevel<string, Record<string, any>>(ROOT_PREFIX, SUBLEVEL_OPTIONS)
        .get(normalizedPath)
    } catch (e: any) {
      if (e.code !== 'LEVEL_NOT_FOUND') {
        throw e
      }
    }

    const delOps = existingItem
      ? makeIndexOpsForDocument(
          normalizedPath,
          collection?.name,
          collectionIndexDefinitions,
          existingItem,
          'del',
          this.level
        )
      : []

    const ops: BatchOp[] = [
      ...delOps,
      ...putOps,
      {
        type: 'put',
        key: normalizedPath,
        value: payload,
        sublevel: this.level.sublevel<string, Record<string, any>>(
          ROOT_PREFIX,
          SUBLEVEL_OPTIONS
        ),
      },
    ]

    await this.level.batch(ops)
  }

  public put = async (
    filepath: string,
    data: { [key: string]: unknown },
    collection?: string
  ) => {
    try {
      if (SYSTEM_FILES.includes(filepath)) {
        throw new Error(`Unexpected put for config file ${filepath}`)
      } else {
        let collectionIndexDefinitions
        if (collection) {
          const indexDefinitions = await this.getIndexDefinitions()
          collectionIndexDefinitions = indexDefinitions?.[collection]
        }

        const normalizedPath = normalizePath(filepath)
        const { stringifiedFile, payload } = await this.stringifyFile(
          filepath,
          data
        )
        await this.bridge.put(normalizedPath, stringifiedFile)
        const putOps = makeIndexOpsForDocument(
          normalizedPath,
          collection,
          collectionIndexDefinitions,
          payload,
          'put',
          this.level
        )

        let existingItem
        try {
          existingItem = await this.level
            .sublevel<string, Record<string, any>>(
              ROOT_PREFIX,
              SUBLEVEL_OPTIONS
            )
            .get(normalizedPath)
        } catch (e: any) {
          if (e.code !== 'LEVEL_NOT_FOUND') {
            throw e
          }
        }
        const delOps = existingItem
          ? makeIndexOpsForDocument(
              normalizedPath,
              collection,
              collectionIndexDefinitions,
              existingItem,
              'del',
              this.level
            )
          : []

        const ops: BatchOp[] = [
          ...delOps,
          ...putOps,
          {
            type: 'put',
            key: normalizedPath,
            value: payload,
            sublevel: this.level.sublevel<string, Record<string, any>>(
              ROOT_PREFIX,
              SUBLEVEL_OPTIONS
            ),
          },
        ]

        await this.level.batch(ops)
      }
      return true
    } catch (error) {
      throw new TinaFetchError(`Error in PUT for ${filepath}`, {
        originalError: error,
        file: filepath,
        collection: collection,
        stack: error.stack,
      })
    }
  }

  public stringifyFile = async (
    filepath: string,
    data: { [key: string]: unknown }
  ) => {
    if (SYSTEM_FILES.includes(filepath)) {
      throw new Error(`Unexpected put for config file ${filepath}`)
    } else {
      const tinaSchema = await this.getSchema()
      const collection = tinaSchema.getCollectionByFullPath(filepath)

      const templateInfo = await tinaSchema.getTemplatesForCollectable(
        collection
      )
      let template
      if (templateInfo.type === 'object') {
        template = templateInfo.template
      }
      if (templateInfo.type === 'union') {
        if (hasOwnProperty(data, '_template')) {
          template = templateInfo.templates.find(
            (t) => lastItem(t.namespace) === data._template
          )
        } else {
          throw new Error(
            `Expected _template to be provided for document in an ambiguous collection`
          )
        }
      }
      if (!template) {
        throw new Error(`Unable to determine template`)
      }
      const field = template.fields.find((field) => {
        if (field.type === 'string' || field.type === 'rich-text') {
          if (field.isBody) {
            return true
          }
        }
        return false
      })
      let payload: { [key: string]: unknown } = {}
      if (['md', 'mdx'].includes(collection.format) && field) {
        Object.entries(data).forEach(([key, value]) => {
          if (key !== field.name) {
            payload[key] = value
          }
        })
        payload['$_body'] = data[field.name]
      } else {
        payload = data
      }
      const extension = path.extname(filepath)
      const stringifiedFile = stringifyFile(
        payload,
        extension,
        templateInfo.type === 'union'
      )
      return {
        stringifiedFile,
        payload,
        keepTemplateKey: templateInfo.type === 'union',
      }
    }
  }

  /**
   * Clears the internal cache of the tinaSchema and the lookup file. This allows the state to be reset
   */
  public clearCache() {
    this.tinaSchema = null
    this._lookup = null
  }

  public flush = async (filepath: string) => {
    const data = await this.get<{ [key: string]: unknown }>(filepath)
    const { stringifiedFile } = await this.stringifyFile(filepath, data)
    return stringifiedFile
  }

  public getLookup = async (returnType: string): Promise<LookupMapType> => {
    const lookupPath = normalizePath(
      path.join(GENERATED_FOLDER, `_lookup.json`)
    )
    if (!this._lookup) {
      const _lookup = await this.level
        .sublevel<string, Record<string, any>>(ROOT_PREFIX, SUBLEVEL_OPTIONS)
        .get(lookupPath)
      // @ts-ignore
      this._lookup = _lookup
    }
    return this._lookup[returnType]
  }
  public getGraphQLSchema = async (): Promise<DocumentNode> => {
    const graphqlPath = normalizePath(
      path.join(GENERATED_FOLDER, `_graphql.json`)
    )
    return (await this.level
      .sublevel<string, Record<string, any>>(ROOT_PREFIX, SUBLEVEL_OPTIONS)
      .get(graphqlPath)) as unknown as DocumentNode
  }
  //TODO - is there a reason why the database fetches some config with "bridge.get", and some with "store.get"?
  public getGraphQLSchemaFromBridge = async (): Promise<DocumentNode> => {
    const graphqlPath = normalizePath(
      path.join(GENERATED_FOLDER, `_graphql.json`)
    )
    const _graphql = await this.bridge.get(graphqlPath)
    return JSON.parse(_graphql)
  }
  public getTinaSchema = async (): Promise<TinaCloudSchemaBase> => {
    const schemaPath = normalizePath(
      path.join(GENERATED_FOLDER, `_schema.json`)
    )
    return (await this.level
      .sublevel<string, Record<string, any>>(ROOT_PREFIX, SUBLEVEL_OPTIONS)
      .get(schemaPath)) as unknown as TinaCloudSchemaBase
  }

  public getSchema = async () => {
    if (this.tinaSchema) {
      return this.tinaSchema
    }
    const schema = await this.getTinaSchema()
    this.tinaSchema = await createSchema({ schema })
    return this.tinaSchema
  }

  public getIndexDefinitions = async (): Promise<
    Record<string, Record<string, IndexDefinition>>
  > => {
    if (!this.collectionIndexDefinitions) {
      await new Promise<void>(async (resolve, reject) => {
        try {
          const schema = await this.getSchema()
          const collections = schema.getCollections()
          for (const collection of collections) {
            const indexDefinitions = {
              [DEFAULT_COLLECTION_SORT_KEY]: { fields: [] }, // provide a default sort key which is the file sort
            }

            if (collection.fields) {
              for (const field of collection.fields as TinaFieldInner<true>[]) {
                if (
                  (field.indexed !== undefined && field.indexed === false) ||
                  field.type ===
                    'object' /* TODO do we want indexes on objects? */
                ) {
                  continue
                }

                indexDefinitions[field.name] = {
                  fields: [
                    {
                      name: field.name,
                      type: field.type,
                      pad:
                        field.type === 'number'
                          ? { fillString: '0', maxLength: DEFAULT_NUMERIC_LPAD }
                          : undefined,
                    },
                  ],
                }
              }
            }

            if (collection.indexes) {
              // build IndexDefinitions for each index in the collection schema
              for (const index of collection.indexes) {
                indexDefinitions[index.name] = {
                  fields: index.fields.map((indexField) => ({
                    name: indexField.name,
                    type: (collection.fields as TinaFieldInner<true>[]).find(
                      (field) => indexField.name === field.name
                    )?.type,
                  })),
                }
              }
            }
            this.collectionIndexDefinitions =
              this.collectionIndexDefinitions || {}
            this.collectionIndexDefinitions[collection.name] = indexDefinitions
          }
          resolve()
        } catch (err) {
          reject(err)
        }
      })
    }

    return this.collectionIndexDefinitions
  }

  public documentExists = async (fullpath: unknown) => {
    try {
      // @ts-ignore assert is string
      await this.get(fullpath)
    } catch (e) {
      return false
    }

    return true
  }

  public query = async (queryOptions: QueryOptions, hydrator) => {
    const {
      first,
      after,
      last,
      before,
      sort = DEFAULT_COLLECTION_SORT_KEY,
      collection,
      filterChain: rawFilterChain,
    } = queryOptions
    let limit = 50
    if (first) {
      limit = first
    } else if (last) {
      limit = last
    }

    const query: {
      gt?: string
      gte?: string
      lt?: string
      lte?: string
      reverse: boolean
    } = { reverse: !!last }

    if (after) {
      query.gt = atob(after)
    } else if (before) {
      query.lt = atob(before)
    }

    const allIndexDefinitions = await this.getIndexDefinitions()
    const indexDefinitions = allIndexDefinitions?.[queryOptions.collection]
    if (!indexDefinitions) {
      throw new Error(
        `No indexDefinitions for collection ${queryOptions.collection}`
      )
    }

    const filterChain = coerceFilterChainOperands(rawFilterChain)

    // Because we default to DEFAULT_COLLECTION_SORT_KEY, the only way this is
    // actually undefined is if the caller specified a non-existent sort key
    const indexDefinition = (sort && indexDefinitions?.[sort]) as
      | IndexDefinition
      | undefined
    const filterSuffixes =
      indexDefinition && makeFilterSuffixes(filterChain, indexDefinition)
    const rootLevel = this.level.sublevel<string, Record<string, any>>(
      ROOT_PREFIX,
      SUBLEVEL_OPTIONS
    )
    const sublevel = indexDefinition
      ? this.level
          .sublevel(collection, SUBLEVEL_OPTIONS)
          .sublevel(sort, SUBLEVEL_OPTIONS)
      : rootLevel

    if (!query.gt && !query.gte) {
      query.gte = filterSuffixes?.left ? filterSuffixes.left : ''
    }

    if (!query.lt && !query.lte) {
      query.lte = filterSuffixes?.right ? `${filterSuffixes.right}\xFF` : '\xFF'
    }

    let edges: { cursor: string; path: string }[] = []
    let startKey: string = ''
    let endKey: string = ''
    let hasPreviousPage = false
    let hasNextPage = false

    const fieldsPattern = indexDefinition?.fields?.length
      ? `${indexDefinition.fields
          .map((p) => `(?<${p.name}>.+)${INDEX_KEY_FIELD_SEPARATOR}`)
          .join('')}`
      : ''
    const valuesRegex = indexDefinition
      ? new RegExp(`^${fieldsPattern}(?<_filepath_>.+)`)
      : new RegExp(`^(?<_filepath_>.+)`)
    const itemFilter = makeFilter({ filterChain })

    // @ts-ignore
    // It looks like tslint is confused by the multiple iterator() overloads
    const iterator = sublevel.iterator<string, Record<string, any>>(query)
    for await (const [key, value] of iterator) {
      const matcher = valuesRegex.exec(key)
      if (
        !matcher ||
        (indexDefinition &&
          matcher.length !== indexDefinition.fields.length + 2)
      ) {
        continue
      }
      const filepath = matcher.groups['_filepath_']
      if (
        !itemFilter(
          filterSuffixes
            ? matcher.groups
            : indexDefinition
            ? await rootLevel.get(filepath)
            : (value as Record<string, any>)
        )
      ) {
        continue
      }

      if (limit !== -1 && edges.length >= limit) {
        if (query.reverse) {
          hasPreviousPage = true
        } else {
          hasNextPage = true
        }
        break
      }

      startKey = startKey || key || ''
      endKey = key || ''
      edges = [...edges, { cursor: key, path: filepath }]
    }

    return {
      edges: await sequential(edges, async (edge) => {
        try {
          const node = await hydrator(edge.path)
          return {
            node,
            cursor: btoa(edge.cursor),
          }
        } catch (error) {
          if (
            error instanceof Error &&
            !edge.path.includes('.tina/__generated__/_graphql.json')
          ) {
            throw new TinaQueryError({
              originalError: error,
              file: edge.path,
              collection,
              stack: error.stack,
            })
          } else {
            // I dont think this should ever happen
            throw error
          }
        }
      }),
      pageInfo: {
        hasPreviousPage,
        hasNextPage,
        startCursor: btoa(startKey),
        endCursor: btoa(endKey),
      },
    }
  }

  public putConfigFiles = async ({
    graphQLSchema,
    tinaSchema,
  }: {
    graphQLSchema: DocumentNode
    tinaSchema: TinaSchema
  }) => {
    if (this.bridge.supportsBuilding()) {
      await this.bridge.putConfig(
        normalizePath(path.join(GENERATED_FOLDER, `_graphql.json`)),
        JSON.stringify(graphQLSchema)
      )
      await this.bridge.putConfig(
        normalizePath(path.join(GENERATED_FOLDER, `_schema.json`)),
        JSON.stringify(tinaSchema.schema)
      )
    }
  }

  private async indexStatusCallbackWrapper(fn: () => Promise<void>) {
    await this.indexStatusCallback({ status: 'inprogress' })
    try {
      await fn()
      await this.indexStatusCallback({ status: 'complete' })
    } catch (error) {
      await this.indexStatusCallback({ status: 'failed', error })
      throw error
    }
  }

  public indexContent = async ({
    graphQLSchema,
    tinaSchema,
  }: {
    graphQLSchema: DocumentNode
    tinaSchema: TinaSchema
  }) => {
    await this.indexStatusCallbackWrapper(async () => {
      const lookup = JSON.parse(
        await this.bridge.get(
          normalizePath(path.join(GENERATED_FOLDER, '_lookup.json'))
        )
      )
      await this.level.clear()
      const rootLevel = this.level.sublevel<string, Record<string, any>>(
        ROOT_PREFIX,
        SUBLEVEL_OPTIONS
      )
      await rootLevel.put(
        normalizePath(path.join(GENERATED_FOLDER, '_graphql.json')),
        graphQLSchema as any
      )
      await rootLevel.put(
        normalizePath(path.join(GENERATED_FOLDER, '_schema.json')),
        tinaSchema.schema as any
      )
      await rootLevel.put(
        normalizePath(path.join(GENERATED_FOLDER, '_lookup.json')),
        lookup
      )
      await this._indexAllContent()
    })
  }

  public deleteContentByPaths = async (documentPaths: string[]) => {
    const operations: DelOp[] = []
    const enqueueOps = async (ops: DelOp[]): Promise<void> => {
      operations.push(...ops)
      while (operations.length >= 25) {
        // make this an option
        await this.level.batch(operations.splice(0, 25))
      }
    }
    await this.indexStatusCallbackWrapper(async () => {
      const { pathsByCollection, nonCollectionPaths, collections } =
        await this.partitionPathsByCollection(documentPaths)

      for (const collection of Object.keys(pathsByCollection)) {
        await _deleteIndexContent(
          this,
          pathsByCollection[collection],
          enqueueOps,
          collections[collection]
        )
      }

      await _deleteIndexContent(this, nonCollectionPaths, enqueueOps, null)
    })
    while (operations.length) {
      await this.level.batch(operations.splice(0, 25))
    }
  }

  public indexContentByPaths = async (documentPaths: string[]) => {
    const operations: BatchOp[] = []
    const enqueueOps = async (ops: BatchOp[]): Promise<void> => {
      operations.push(...ops)
      while (operations.length >= 25) {
        // make this an option
        await this.level.batch(operations.splice(0, 25))
      }
    }
    await this.indexStatusCallbackWrapper(async () => {
      const { pathsByCollection, nonCollectionPaths, collections } =
        await this.partitionPathsByCollection(documentPaths)

      for (const collection of Object.keys(pathsByCollection)) {
        await _indexContent(
          this,
          pathsByCollection[collection],
          enqueueOps,
          collections[collection]
        )
      }
      await _indexContent(this, nonCollectionPaths, enqueueOps)
    })
    while (operations.length) {
      await this.level.batch(operations.splice(0, 25))
    }
  }

  public delete = async (filepath: string) => {
    const collection = await this.collectionForPath(filepath)
    let collectionIndexDefinitions
    if (collection) {
      const indexDefinitions = await this.getIndexDefinitions()
      collectionIndexDefinitions = indexDefinitions?.[collection.name]
    }
    this.level.sublevel<string, Record<string, any>>(
      ROOT_PREFIX,
      SUBLEVEL_OPTIONS
    )
    const itemKey = normalizePath(filepath)
    const rootSublevel = this.level.sublevel<string, Record<string, any>>(
      ROOT_PREFIX,
      SUBLEVEL_OPTIONS
    )
    const item = await rootSublevel.get(itemKey)
    if (item) {
      await this.level.batch([
        ...makeIndexOpsForDocument<Record<string, any>>(
          filepath,
          collection.name,
          collectionIndexDefinitions,
          item,
          'del',
          this.level
        ),
        {
          type: 'del',
          key: itemKey,
          sublevel: rootSublevel,
        },
      ])
    }

    await this.bridge.delete(normalizePath(filepath))
  }

  public _indexAllContent = async () => {
    const tinaSchema = await this.getSchema()
    const operations: PutOp[] = []
    const enqueueOps = async (ops: PutOp[]): Promise<void> => {
      operations.push(...ops)
      while (operations.length >= 25) {
        // make this an option
        const batchOps = operations.splice(0, 25)
        await this.level.batch(batchOps)
      }
    }
    await sequential(tinaSchema.getCollections(), async (collection) => {
      const documentPaths = await this.bridge.glob(
        normalizePath(collection.path),
        collection.format || 'md'
      )
      await _indexContent(this, documentPaths, enqueueOps, collection)
    })
    while (operations.length) {
      await this.level.batch(operations.splice(0, 25))
    }
  }

  public addToLookupMap = async (lookup: LookupMapType) => {
    const lookupPath = path.join(GENERATED_FOLDER, `_lookup.json`)
    let lookupMap
    try {
      lookupMap = JSON.parse(await this.bridge.get(normalizePath(lookupPath)))
    } catch (e) {
      lookupMap = {}
    }
    const updatedLookup = {
      ...lookupMap,
      [lookup.type]: lookup,
    }
    await this.bridge.putConfig(
      normalizePath(lookupPath),
      JSON.stringify(updatedLookup)
    )
  }
}

function hasOwnProperty<X extends {}, Y extends PropertyKey>(
  obj: X,
  prop: Y
): obj is X & Record<Y, unknown> {
  return obj.hasOwnProperty(prop)
}

export type LookupMapType =
  | GlobalDocumentLookup
  | CollectionDocumentLookup
  | MultiCollectionDocumentLookup
  | MultiCollectionDocumentListLookup
  | CollectionDocumentListLookup
  | UnionDataLookup
  | NodeDocument

type NodeDocument = {
  type: string
  resolveType: 'nodeDocument'
}
type GlobalDocumentLookup = {
  type: string
  resolveType: 'globalDocument'
  collection: string
}
type CollectionDocumentLookup = {
  type: string
  resolveType: 'collectionDocument'
  collection: string
}
type MultiCollectionDocumentLookup = {
  type: string
  resolveType: 'multiCollectionDocument'
  createDocument: 'create'
  updateDocument: 'update'
}
type MultiCollectionDocumentListLookup = {
  type: string
  resolveType: 'multiCollectionDocumentList'
  collections: string[]
}
export type CollectionDocumentListLookup = {
  type: string
  resolveType: 'collectionDocumentList'
  collection: string
}
type UnionDataLookup = {
  type: string
  resolveType: 'unionData'
  collection?: string
  typeMap: { [templateName: string]: string }
}

const _indexContent = async (
  database: Database,
  documentPaths: string[],
  enqueueOps: (ops: BatchOp[]) => Promise<void>,
  collection?:
    | CollectionFieldsWithNamespace<true>
    | CollectionTemplatesWithNamespace<true>
) => {
  let collectionIndexDefinitions
  if (collection) {
    const indexDefinitions = await database.getIndexDefinitions()
    collectionIndexDefinitions = indexDefinitions?.[collection.name]
    if (!collectionIndexDefinitions) {
      throw new Error(`No indexDefinitions for collection ${collection.name}`)
    }
  }

  await sequential(documentPaths, async (filepath) => {
    try {
      const dataString = await database.bridge.get(normalizePath(filepath))
      const data = parseFile(dataString, path.extname(filepath), (yup) =>
        yup.object({})
      )
      const normalizedPath = normalizePath(filepath)
      await enqueueOps([
        ...makeIndexOpsForDocument<Record<string, any>>(
          normalizedPath,
          collection?.name,
          collectionIndexDefinitions,
          data,
          'put',
          database.level
        ),
        {
          type: 'put',
          key: normalizedPath,
          value: data as any,
          sublevel: database.level.sublevel<string, Record<string, any>>(
            ROOT_PREFIX,
            SUBLEVEL_OPTIONS
          ),
        },
      ])
    } catch (error) {
      throw new TinaFetchError(`Unable to seed ${filepath}`, {
        originalError: error,
        file: filepath,
        collection: collection.name,
        stack: error.stack,
      })
    }
  })
}

const _deleteIndexContent = async (
  database: Database,
  documentPaths: string[],
  enequeueOps: (ops: BatchOp[]) => Promise<void>,
  collection?:
    | CollectionFieldsWithNamespace<true>
    | CollectionTemplatesWithNamespace<true>
) => {
  let collectionIndexDefinitions
  if (collection) {
    const indexDefinitions = await database.getIndexDefinitions()
    collectionIndexDefinitions = indexDefinitions?.[collection.name]
    if (!collectionIndexDefinitions) {
      throw new Error(`No indexDefinitions for collection ${collection.name}`)
    }
  }

  const rootLevel = database.level.sublevel<string, Record<string, any>>(
    ROOT_PREFIX,
    SUBLEVEL_OPTIONS
  )
  await sequential(documentPaths, async (filepath) => {
    const itemKey = normalizePath(filepath)
    const item = await rootLevel.get(itemKey)
    if (item) {
      await enequeueOps([
        ...makeIndexOpsForDocument(
          itemKey,
          collection.name,
          collectionIndexDefinitions,
          item,
          'del',
          database.level
        ),
        { type: 'del', key: itemKey, sublevel: rootLevel },
      ])
    }
  })
}
