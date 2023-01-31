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

import Progress from 'progress'
import type { Bridge, Database } from '@tinacms/graphql'
import type { TinaCloudSchema } from '@tinacms/schema-tools'
import { ConfigBuilder } from '../../buildTina'
import { parseURL } from './waitForIndexing'
import crypto from 'crypto'

//  This was taken from packages/tinacms/src/unifiedClient/index.ts
// TODO: maybe move this to a shared util package?

async function request(args: {
  url: string
  token: string
  schemaId: string
}): Promise<{ status: string; timestamp: number }> {
  const headers = new Headers()
  if (args.token) {
    headers.append('X-API-KEY', args.token)
  }
  if (args.schemaId) {
    headers.append('X-SCHEMA-ID', args.schemaId)
  }
  headers.append('Content-Type', 'application/json')

  const url = args?.url

  const res = await fetch(url, {
    method: 'GET',
    headers,
    redirect: 'follow',
  })
  const json = await res.json()
  if (!res.ok) {
    let additionalInfo = ''
    if (res.status === 401 || res.status === 403) {
      additionalInfo =
        'Please check that your client ID, URL and read only token are configured properly.'
    }
    if (json) {
      additionalInfo += `\n\nMessage from server: ${json.message}`
    }
    throw new Error(
      `Server responded with status code ${res.status}, ${res.statusText}. ${
        additionalInfo ? additionalInfo : ''
      } Please see our FAQ for more information: https://tina.io/docs/errors/faq/`
    )
  }
  if (json.errors) {
    throw new Error(
      `Unable to fetch, please see our FAQ for more information: https://tina.io/docs/errors/faq/

      Errors: \n\t${json.errors.map((error) => error.message).join('\n')}`
    )
  }
  return {
    status: json?.status,
    timestamp: json?.timestamp,
  }
}

export const checkClientInfo = async (
  ctx: {
    builder: ConfigBuilder
    rootPath: string
    database: Database
    bridge: Bridge
    usingTs: boolean
    schema?: TinaCloudSchema<false>
    apiUrl: string
  },
  next,
  _options: { verbose?: boolean }
) => {
  const config = ctx.schema?.config
  const token = config.token
  const { clientId, branch, host } = parseURL(ctx.apiUrl)
  const url = `https://${host}/db/${clientId}/status/${branch}`
  const bar = new Progress('Checking clientId, token and branch. :prog', 1)
  const schemaId = crypto
    .createHash('sha256')
    .update(JSON.stringify(ctx.schema))
    .digest('hex')

  try {
    await request({
      token,
      url,
      schemaId,
    })
    bar.tick({
      prog: '✅',
    })
  } catch (e) {
    bar.tick({
      prog: '❌',
    })
    console.warn(
      `Error when checking client information. You provided \n\n ${JSON.stringify(
        {
          branch: config?.branch,
          clientId: config?.clientId,
          token: config?.token,
        },
        null,
        2
      )}\n\n Please check you have the correct "clientId", "branch" and "token" configured. For more information see https://tina.io/docs/tina-cloud/connecting-site/`
    )

    throw e
  }

  next()
}
