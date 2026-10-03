#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { createStatefulServer } from "@smithery/sdk/server/stateful.js"
import { instrumentServer } from "@shinzolabs/instrumentation-mcp"
import { z } from "zod"

function formatResponse(data: any) {
  let text = ''

  if (typeof data === 'string') {
    text = data
  } else if (data === null || data === undefined) {
    text = "No data returned"
  } else if (typeof data === 'object') {
    text = JSON.stringify(data)
  } else {
    text = String(data)
  }

  return { content: [{ type: "text", text }] }
}

async function makeApiRequest(apiKey: string, endpoint: string, params: Record<string, any> = {}, method = 'GET', body: Record<string, any> | null = null) {
  if (!apiKey) {
    throw new Error("HUBSPOT_ACCESS_TOKEN environment variable is not set")
  }

  const queryParams = new URLSearchParams()
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined) queryParams.append(key, value.toString())
  })

  const url = `https://api.hubapi.com${endpoint}${queryParams.toString() ? `?${queryParams.toString()}` : ''}`

  const headers: Record<string, string> = {
    'Accept': 'application/json',
    'Authorization': `Bearer ${apiKey}`
  }

  if (body) headers['Content-Type'] = 'application/json'

  const requestOptions: RequestInit = { method, headers }

  if (body) requestOptions.body = JSON.stringify(body)

  const response = await fetch(url, requestOptions)

  if (!response.ok) return `Error fetching data from HubSpot: Status ${response.status}`

  if (response.status === 204) return `No data returned: Status ${response.status}`

  return await response.json()
}

async function makeApiRequestWithErrorHandling(apiKey: string, endpoint: string, params: Record<string, any> = {}, method = 'GET', body: Record<string, any> | null = null) {
  try {
    const data = await makeApiRequest(apiKey, endpoint, params, method, body)
    return formatResponse(data)
  } catch (error: any) {
    return formatResponse(`Error performing request: ${error.message}`)
  }
}

async function handleEndpoint(apiCall: () => Promise<any>) {
  try {
    return await apiCall()
  } catch (error: any) {
    return formatResponse(error.message)
  }
}

function getConfig(config: any) {
  return {
    hubspotAccessToken: config?.HUBSPOT_ACCESS_TOKEN || process.env.HUBSPOT_ACCESS_TOKEN,
    telemetryEnabled: config?.TELEMETRY_ENABLED || process.env.TELEMETRY_ENABLED || "true"
  }
}

function createServer({ config }: { config?: any } = {}) {
  const serverInfo = {
    name: "HubSpot-MCP",
    version: "2.0.5",
    description: "An extensive MCP for the HubSpot API"
  }
  const server = new McpServer(serverInfo)

  const { hubspotAccessToken, telemetryEnabled } = getConfig(config)

  if (telemetryEnabled !== "false") {
    instrumentServer(server, {
      serverName: serverInfo.name,
      serverVersion: serverInfo.version,
      exporterEndpoint: "https://api.otel.shinzo.tech/v1"
    })
  }

  // Companies: https://developers.hubspot.com/docs/reference/api/crm/objects/companies

  const companyPropertiesSchema = z.object({
    name: z.string().optional(),
    domain: z.string().optional(),
    website: z.string().url().optional(),
    description: z.string().optional(),
    industry: z.string().optional(),
    numberofemployees: z.number().optional(),
    annualrevenue: z.number().optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    country: z.string().optional(),
    phone: z.string().optional(),
    address: z.string().optional(),
    address2: z.string().optional(),
    zip: z.string().optional(),
    type: z.string().optional(),
    lifecyclestage: z.enum(['lead', 'customer', 'opportunity', 'subscriber', 'other']).optional(),
  }).catchall(z.any())

  server.tool("crm_create_company",
    "Create a new company with validated properties",
    {
      properties: companyPropertiesSchema,
      associations: z.array(z.object({
        to: z.object({ id: z.string() }),
        types: z.array(z.object({
          associationCategory: z.string(),
          associationTypeId: z.number()
        }))
      })).optional()
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = '/crm/v3/objects/companies'
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'POST', {
          properties: params.properties,
          associations: params.associations
        })
      })
    }
  )

  server.tool("crm_update_company",
    "Update an existing company with validated properties",
    {
      companyId: z.string(),
      properties: companyPropertiesSchema
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = `/crm/v3/objects/companies/${params.companyId}`
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'PATCH', {
          properties: params.properties
        })
      })
    }
  )

  server.tool("crm_get_company",
    "Get a single company by ID with specific properties and associations",
    {
      companyId: z.string(),
      properties: z.array(z.string()).optional(),
      associations: z.array(z.enum(['contacts', 'deals', 'tickets'])).optional()
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = `/crm/v3/objects/companies/${params.companyId}`
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {
          properties: params.properties?.join(','),
          associations: params.associations?.join(',')
        })
      })
    }
  )

  server.tool("crm_search_companies",
    "Search companies with company-specific filters",
    {
      filterGroups: z.array(z.object({
        filters: z.array(z.object({
          propertyName: z.string(),
          operator: z.enum(['EQ', 'NEQ', 'LT', 'LTE', 'GT', 'GTE', 'BETWEEN', 'IN', 'NOT_IN', 'HAS_PROPERTY', 'NOT_HAS_PROPERTY', 'CONTAINS_TOKEN', 'NOT_CONTAINS_TOKEN']),
          value: z.any()
        }))
      })),
      properties: z.array(z.string()).optional(),
      limit: z.number().min(1).max(100).optional(),
      after: z.string().optional(),
      sorts: z.array(z.object({
        propertyName: z.string(),
        direction: z.enum(['ASCENDING', 'DESCENDING'])
      })).optional()
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = '/crm/v3/objects/companies/search'
        return await makeApiRequestWithErrorHandling(hubspotAccessToken,  endpoint, {}, 'POST', {
          filterGroups: params.filterGroups,
          properties: params.properties,
          limit: params.limit,
          after: params.after,
          sorts: params.sorts
        })
      })
    }
  )

  server.tool("crm_batch_create_companies",
    "Create multiple companies in a single request",
    {
      inputs: z.array(z.object({
        properties: companyPropertiesSchema,
        associations: z.array(z.object({
          to: z.object({ id: z.string() }),
          types: z.array(z.object({
            associationCategory: z.string(),
            associationTypeId: z.number()
          }))
        })).optional()
      }))
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = '/crm/v3/objects/companies/batch/create'
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'POST', {
          inputs: params.inputs
        })
      })
    }
  )

  server.tool("crm_batch_update_companies",
    "Update multiple companies in a single request",
    {
      inputs: z.array(z.object({
        id: z.string(),
        properties: companyPropertiesSchema
      }))
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = '/crm/v3/objects/companies/batch/update'
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'POST', {
          inputs: params.inputs
        })
      })
    }
  )

  server.tool("crm_get_company_properties",
    "Get all properties for companies",
    {
      archived: z.boolean().optional(),
      properties: z.array(z.string()).optional()
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = '/crm/v3/properties/companies'
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {
          archived: params.archived,
          properties: params.properties?.join(',')
        })
      })
    }
  )

  server.tool("crm_create_company_property",
    "Create a new company property",
    {
      name: z.string(),
      label: z.string(),
      type: z.enum(['string', 'number', 'date', 'datetime', 'enumeration', 'bool']),
      fieldType: z.enum(['text', 'textarea', 'select', 'radio', 'checkbox', 'number', 'date', 'file']),
      groupName: z.string(),
      description: z.string().optional(),
      options: z.array(z.object({
        label: z.string(),
        value: z.string(),
        description: z.string().optional(),
        displayOrder: z.number().optional(),
        hidden: z.boolean().optional()
      })).optional(),
      displayOrder: z.number().optional(),
      hasUniqueValue: z.boolean().optional(),
      hidden: z.boolean().optional(),
      formField: z.boolean().optional()
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = '/crm/v3/properties/companies'
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'POST', params)
      })
    }
  )

  // Objects: https://developers.hubspot.com/docs/reference/api/crm/objects/objects

  server.tool("crm_list_objects",
    "List CRM objects of a specific type with optional filtering and pagination",
    {
      objectType: z.enum(['companies', 'contacts', 'deals', 'tickets', 'products', 'line_items', 'quotes', 'custom']),
      properties: z.array(z.string()).optional(),
      after: z.string().optional(),
      limit: z.number().min(1).max(100).optional(),
      archived: z.boolean().optional()
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = `/crm/v3/objects/${params.objectType}`
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {
          properties: params.properties?.join(','),
          after: params.after,
          limit: params.limit,
          archived: params.archived
        })
      })
    }
  )

  server.tool("crm_get_object",
    "Get a single CRM object by ID",
    {
      objectType: z.enum(['companies', 'contacts', 'deals', 'tickets', 'products', 'line_items', 'quotes', 'custom']),
      objectId: z.string(),
      properties: z.array(z.string()).optional(),
      associations: z.array(z.string()).optional()
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = `/crm/v3/objects/${params.objectType}/${params.objectId}`
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {
          properties: params.properties?.join(','),
          associations: params.associations?.join(',')
        })
      })
    }
  )

  server.tool("crm_create_object",
    "Create a new CRM object",
    {
      objectType: z.enum(['companies', 'contacts', 'deals', 'tickets', 'products', 'line_items', 'quotes', 'custom']),
      properties: z.record(z.any()),
      associations: z.array(z.object({
        to: z.object({ id: z.string() }),
        types: z.array(z.object({
          associationCategory: z.string(),
          associationTypeId: z.number()
        }))
      })).optional()
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = `/crm/v3/objects/${params.objectType}`
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'POST', {
          properties: params.properties,
          associations: params.associations
        })
      })
    }
  )

  server.tool("crm_update_object",
    "Update an existing CRM object",
    {
      objectType: z.enum(['companies', 'contacts', 'deals', 'tickets', 'products', 'line_items', 'quotes', 'custom']),
      objectId: z.string(),
      properties: z.record(z.any())
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = `/crm/v3/objects/${params.objectType}/${params.objectId}`
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'PATCH', {
          properties: params.properties
        })
      })
    }
  )

  server.tool("crm_archive_object",
    "Archive (delete) a CRM object",
    {
      objectType: z.enum(['companies', 'contacts', 'deals', 'tickets', 'products', 'line_items', 'quotes', 'custom']),
      objectId: z.string()
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = `/crm/v3/objects/${params.objectType}/${params.objectId}`
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'DELETE')
      })
    }
  )

  server.tool("crm_search_objects",
    "Search CRM objects using filters",
    {
      objectType: z.enum(['companies', 'contacts', 'deals', 'tickets', 'products', 'line_items', 'quotes', 'custom']),
      filterGroups: z.array(z.object({
        filters: z.array(z.object({
          propertyName: z.string(),
          operator: z.enum(['EQ', 'NEQ', 'LT', 'LTE', 'GT', 'GTE', 'BETWEEN', 'IN', 'NOT_IN', 'HAS_PROPERTY', 'NOT_HAS_PROPERTY', 'CONTAINS_TOKEN', 'NOT_CONTAINS_TOKEN']),
          value: z.any()
        }))
      })),
      properties: z.array(z.string()).optional(),
      limit: z.number().min(1).max(100).optional(),
      after: z.string().optional(),
      sorts: z.array(z.object({
        propertyName: z.string(),
        direction: z.enum(['ASCENDING', 'DESCENDING'])
      })).optional()
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = `/crm/v3/objects/${params.objectType}/search`
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'POST', {
          filterGroups: params.filterGroups,
          properties: params.properties,
          limit: params.limit,
          after: params.after,
          sorts: params.sorts
        })
      })
    }
  )

  server.tool("crm_batch_create_objects",
    "Create multiple CRM objects in a single request",
    {
      objectType: z.enum(['companies', 'contacts', 'deals', 'tickets', 'products', 'line_items', 'quotes', 'custom']),
      inputs: z.array(z.object({
        properties: z.record(z.any()),
        associations: z.array(z.object({
          to: z.object({ id: z.string() }),
          types: z.array(z.object({
            associationCategory: z.string(),
            associationTypeId: z.number()
          }))
        })).optional()
      }))
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = `/crm/v3/objects/${params.objectType}/batch/create`
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'POST', {
          inputs: params.inputs
        })
      })
    }
  )

  server.tool("crm_batch_read_objects",
    "Create multiple CRM objects in a single request",
    {
      objectType: z.enum(['companies', 'contacts', 'deals', 'tickets', 'products', 'line_items', 'quotes', 'custom']),
      propertiesWithHistory: z.array(z.string()).optional(),
      idProperty: z.string().optional(),
      objectIds: z.array(z.string()),
      properties: z.array(z.string()).optional()
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = `/crm/v3/objects/${params.objectType}/batch/read`
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'POST', {
          propertiesWithHistory: params.propertiesWithHistory,
          idProperty: params.idProperty,
          inputs: params.objectIds.map((id: string) => ({ id })),
          properties: params.properties
        })
      })
    }
  )

  server.tool("crm_batch_update_objects",
    "Update multiple CRM objects in a single request",
    {
      objectType: z.enum(['companies', 'contacts', 'deals', 'tickets', 'products', 'line_items', 'quotes', 'custom']),
      inputs: z.array(z.object({
        id: z.string(),
        properties: z.record(z.any())
      }))
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = `/crm/v3/objects/${params.objectType}/batch/update`
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'POST', {
          inputs: params.inputs
        })
      })
    }
  )

  server.tool("crm_batch_archive_objects",
    "Archive (delete) multiple CRM objects in a single request",
    {
      objectType: z.enum(['companies', 'contacts', 'deals', 'tickets', 'products', 'line_items', 'quotes', 'custom']),
      objectIds: z.array(z.string()),
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = `/crm/v3/objects/${params.objectType}/batch/archive`
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'POST', {
          inputs: params.objectIds.map((id: string) => ({ id }))
        })
      })
    }
  )

  // Association Details: https://developers.hubspot.com/docs/reference/api/crm/associations/association-details

  server.tool("crm_list_association_types",
    "List all available association types for a given object type pair",
    {
      fromObjectType: z.enum(['companies', 'contacts', 'deals', 'tickets', 'products', 'line_items', 'quotes', 'custom']),
      toObjectType: z.enum(['companies', 'contacts', 'deals', 'tickets', 'products', 'line_items', 'quotes', 'custom'])
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = `/crm/v4/associations/${params.fromObjectType}/${params.toObjectType}/types`
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint)
      })
    }
  )

  server.tool("crm_get_associations",
    "Get all associations of a specific type between objects",
    {
      fromObjectType: z.enum(['companies', 'contacts', 'deals', 'tickets', 'products', 'line_items', 'quotes', 'custom']),
      toObjectType: z.enum(['companies', 'contacts', 'deals', 'tickets', 'products', 'line_items', 'quotes', 'custom']),
      fromObjectId: z.string(),
      after: z.string().optional(),
      limit: z.number().min(1).max(500).optional()
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = `/crm/v4/objects/${params.fromObjectType}/${params.fromObjectId}/associations/${params.toObjectType}`
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {
          after: params.after,
          limit: params.limit
        })
      })
    }
  )

  server.tool("crm_create_association",
    "Create an association between two objects",
    {
      fromObjectType: z.enum(['companies', 'contacts', 'deals', 'tickets', 'products', 'line_items', 'quotes', 'custom']),
      toObjectType: z.enum(['companies', 'contacts', 'deals', 'tickets', 'products', 'line_items', 'quotes', 'custom']),
      fromObjectId: z.string(),
      toObjectId: z.string(),
      associationTypes: z.array(z.object({
        associationCategory: z.string(),
        associationTypeId: z.number()
      }))
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = `/crm/v4/objects/${params.fromObjectType}/${params.fromObjectId}/associations/${params.toObjectType}/${params.toObjectId}`
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'PUT', {
          types: params.associationTypes
        })
      })
    }
  )

  server.tool("crm_archive_association",
    "Archive (delete) an association between two objects",
    {
      fromObjectType: z.enum(['companies', 'contacts', 'deals', 'tickets', 'products', 'line_items', 'quotes', 'custom']),
      toObjectType: z.enum(['companies', 'contacts', 'deals', 'tickets', 'products', 'line_items', 'quotes', 'custom']),
      fromObjectId: z.string(),
      toObjectId: z.string()
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = `/crm/v4/objects/${params.fromObjectType}/${params.fromObjectId}/associations/${params.toObjectType}/${params.toObjectId}`
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'DELETE')
      })
    }
  )

  server.tool("crm_batch_create_associations",
    "Create multiple associations in a single request",
    {
      fromObjectType: z.enum(['companies', 'contacts', 'deals', 'tickets', 'products', 'line_items', 'quotes', 'custom']),
      toObjectType: z.enum(['companies', 'contacts', 'deals', 'tickets', 'products', 'line_items', 'quotes', 'custom']),
      inputs: z.array(z.object({
        from: z.object({ id: z.string() }),
        to: z.object({ id: z.string() }),
        types: z.array(z.object({
          associationCategory: z.string(),
          associationTypeId: z.number()
        }))
      }))
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = `/crm/v4/associations/${params.fromObjectType}/${params.toObjectType}/batch/create`
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'POST', {
          inputs: params.inputs
        })
      })
    }
  )

  server.tool("crm_batch_archive_associations",
    "Archive (delete) multiple associations in a single request",
    {
      fromObjectType: z.enum(['companies', 'contacts', 'deals', 'tickets', 'products', 'line_items', 'quotes', 'custom']),
      toObjectType: z.enum(['companies', 'contacts', 'deals', 'tickets', 'products', 'line_items', 'quotes', 'custom']),
      inputs: z.array(z.object({
        from: z.object({ id: z.string() }),
        to: z.object({ id: z.string() })
      }))
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = `/crm/v4/associations/${params.fromObjectType}/${params.toObjectType}/batch/archive`
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'POST', {
          inputs: params.inputs
        })
      })
    }
  )

  // Contacts: https://developers.hubspot.com/docs/reference/api/crm/objects/contacts

  const contactPropertiesSchema = z.object({
    email: z.string().email().optional(),
    firstname: z.string().optional(),
    lastname: z.string().optional(),
    phone: z.string().optional(),
    mobilephone: z.string().optional(),
    company: z.string().optional(),
    jobtitle: z.string().optional(),
    lifecyclestage: z.enum(['subscriber', 'lead', 'marketingqualifiedlead', 'salesqualifiedlead', 'opportunity', 'customer', 'evangelist', 'other']).optional(),
    leadstatus: z.enum(['new', 'open', 'inprogress', 'opennotcontacted', 'opencontacted', 'closedconverted', 'closednotconverted']).optional(),
    address: z.string().optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    zip: z.string().optional(),
    country: z.string().optional(),
    website: z.string().url().optional(),
    twitterhandle: z.string().optional(),
    facebookfanpage: z.string().optional(),
    linkedinbio: z.string().optional(),
  }).catchall(z.any())

  server.tool("crm_create_contact",
    "Create a new contact with validated properties",
    {
      properties: contactPropertiesSchema,
      associations: z.array(z.object({
        to: z.object({ id: z.string() }),
        types: z.array(z.object({
          associationCategory: z.string(),
          associationTypeId: z.number()
        }))
      })).optional()
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = '/crm/v3/objects/contacts'
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'POST', {
          properties: params.properties,
          associations: params.associations
        })
      })
    }
  )

  server.tool("crm_update_contact",
    "Update an existing contact with validated properties",
    {
      contactId: z.string(),
      properties: contactPropertiesSchema
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = `/crm/v3/objects/contacts/${params.contactId}`
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'PATCH', {
          properties: params.properties
        })
      })
    }
  )

  server.tool("crm_get_contact",
    "Get a single contact by ID or email with specific properties and associations",
    {
      contactId: z.string().describe("HubSpot Contact ID or email address"),
      properties: z.array(z.string()).optional(),
      associations: z.array(z.enum(['companies', 'deals', 'tickets', 'calls', 'emails', 'meetings', 'notes'])).optional()
    },
    async (params) => {
      return handleEndpoint(async () => {
        const isEmail = params.contactId.includes('@')
        const endpoint = `/crm/v3/objects/contacts/${encodeURIComponent(params.contactId)}`
        const queryParams: Record<string, any> = {
          properties: params.properties?.join(','),
          associations: params.associations?.join(',')
        }
        if (isEmail) {
          queryParams.idProperty = 'email'
        }
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, queryParams)
      })
    }
  )

  server.tool("contact_get_web_analytics",
    "Get contact web analytics, website page views, visits, browsing history, traffic sources, and referrers. Use this tool ONLY when asked which web pages a contact visited on the website, how many times they visited, their landing page, or traffic source. CRITICAL NEGATIVE CONSTRAINT: Do NOT use this tool for reading customer chat, Facebook Messenger, live chat, or conversation messages. For conversation messages or customer chat history, use conversations_get_contact_messages or conversations_list_threads.",
    {
      contactId: z.string().describe("HubSpot Contact ID or email address"),
      additionalProperties: z.array(z.string()).optional().describe("Optional extra contact properties to retrieve")
    },
    async (params) => {
      return handleEndpoint(async () => {
        const isEmail = params.contactId.includes('@')
        const endpoint = `/crm/v3/objects/contacts/${encodeURIComponent(params.contactId)}`
        const defaultAnalyticsProps = [
          'email',
          'firstname',
          'lastname',
          'hs_analytics_first_url',
          'hs_analytics_last_url',
          'hs_analytics_num_page_views',
          'hs_analytics_num_visits',
          'hs_analytics_first_referrer',
          'hs_analytics_last_referrer',
          'hs_analytics_first_visit_timestamp',
          'hs_analytics_last_visit_timestamp',
          'hs_analytics_source',
          'hs_analytics_source_data_1',
          'hs_analytics_source_data_2',
          'hs_latest_source',
          'hs_latest_source_data_1',
          'hs_latest_source_data_2',
          'hs_latest_source_timestamp',
          'hs_analytics_average_page_views',
          'hs_analytics_first_touch_converting_campaign',
          'hs_analytics_last_touch_converting_campaign',
          'ip_city',
          'ip_country',
          'ip_state',
          'hs_ip_timezone'
        ]
        const allProps = Array.from(new Set([...defaultAnalyticsProps, ...(params.additionalProperties || [])]))
        const queryParams: Record<string, any> = {
          properties: allProps.join(',')
        }
        if (isEmail) {
          queryParams.idProperty = 'email'
        }
        const data = await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, queryParams)
        if (data && typeof data === 'object' && !Array.isArray(data)) {
          return {
            _guidance: "Note: This tool only returns website browsing history and traffic sources. It does NOT contain chat/Messenger/conversation messages. To read conversations or chat messages for this contact, call conversations_get_contact_messages.",
            ...data
          }
        }
        return data
      })
    }
  )

  server.tool("crm_search_contacts",
    "Search contacts with contact-specific filters",
    {
      filterGroups: z.array(z.object({
        filters: z.array(z.object({
          propertyName: z.string(),
          operator: z.enum(['EQ', 'NEQ', 'LT', 'LTE', 'GT', 'GTE', 'BETWEEN', 'IN', 'NOT_IN', 'HAS_PROPERTY', 'NOT_HAS_PROPERTY', 'CONTAINS_TOKEN', 'NOT_CONTAINS_TOKEN']),
          value: z.any()
        }))
      })),
      properties: z.array(z.string()).optional(),
      limit: z.number().min(1).max(100).optional(),
      after: z.string().optional(),
      sorts: z.array(z.object({
        propertyName: z.string(),
        direction: z.enum(['ASCENDING', 'DESCENDING'])
      })).optional()
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = '/crm/v3/objects/contacts/search'
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'POST', {
          filterGroups: params.filterGroups,
          properties: params.properties,
          limit: params.limit,
          after: params.after,
          sorts: params.sorts
        })
      })
    }
  )

  server.tool("crm_batch_create_contacts",
    "Create multiple contacts in a single request",
    {
      inputs: z.array(z.object({
        properties: contactPropertiesSchema,
        associations: z.array(z.object({
          to: z.object({ id: z.string() }),
          types: z.array(z.object({
            associationCategory: z.string(),
            associationTypeId: z.number()
          }))
        })).optional()
      }))
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = '/crm/v3/objects/contacts/batch/create'
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'POST', {
          inputs: params.inputs
        })
      })
    }
  )

  server.tool("crm_batch_update_contacts",
    "Update multiple contacts in a single request",
    {
      inputs: z.array(z.object({
        id: z.string(),
        properties: contactPropertiesSchema
      }))
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = '/crm/v3/objects/contacts/batch/update'
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'POST', {
          inputs: params.inputs
        })
      })
    }
  )

  server.tool("crm_get_contact_properties",
    "Get schema definitions of all contact properties in the HubSpot portal (NOTE: DO NOT use this tool to read values of a single contact; to get an individual contact's values, use crm_get_contact with properties parameter)",
    {
      archived: z.boolean().optional(),
      properties: z.array(z.string()).optional()
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = '/crm/v3/properties/contacts'
        const res: any = await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {
          archived: params.archived,
          properties: params.properties?.join(',')
        })
        if (res && Array.isArray(res.results)) {
          const simplified = res.results.map((p: any) => ({
            name: p.name,
            label: p.label,
            type: p.type,
            fieldType: p.fieldType,
            description: p.description
          }))
          return { total: simplified.length, properties: simplified }
        }
        return res
      })
    }
  )

  server.tool("crm_create_contact_property",
    "Create a new contact property",
    {
      name: z.string(),
      label: z.string(),
      type: z.enum(['string', 'number', 'date', 'datetime', 'enumeration', 'bool']),
      fieldType: z.enum(['text', 'textarea', 'select', 'radio', 'checkbox', 'number', 'date', 'file']),
      groupName: z.string(),
      description: z.string().optional(),
      options: z.array(z.object({
        label: z.string(),
        value: z.string(),
        description: z.string().optional(),
        displayOrder: z.number().optional(),
        hidden: z.boolean().optional()
      })).optional(),
      displayOrder: z.number().optional(),
      hasUniqueValue: z.boolean().optional(),
      hidden: z.boolean().optional(),
      formField: z.boolean().optional()
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = '/crm/v3/properties/contacts'
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'POST', params)
      })
    }
  )

  // Leads: https://developers.hubspot.com/docs/reference/api/crm/objects/leads

  const leadPropertiesSchema = z.object({
    email: z.string().email().optional(),
    firstname: z.string().optional(),
    lastname: z.string().optional(),
    phone: z.string().optional(),
    company: z.string().optional(),
    jobtitle: z.string().optional(),
    leadstatus: z.enum(['new', 'open', 'in_progress', 'qualified', 'unqualified', 'converted', 'lost']).optional(),
    leadsource: z.string().optional(),
    industry: z.string().optional(),
    annualrevenue: z.number().optional(),
    numberofemployees: z.number().optional(),
    rating: z.enum(['hot', 'warm', 'cold']).optional(),
    website: z.string().url().optional(),
    address: z.string().optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    zip: z.string().optional(),
    country: z.string().optional(),
    notes: z.string().optional(),
  }).catchall(z.any())

  server.tool("crm_create_lead",
    "Create a new lead with validated properties",
    {
      properties: leadPropertiesSchema,
      associations: z.array(z.object({
        to: z.object({ id: z.string() }),
        types: z.array(z.object({
          associationCategory: z.string(),
          associationTypeId: z.number()
        }))
      })).optional()
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = '/crm/v3/objects/leads'
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'POST', {
          properties: params.properties,
          associations: params.associations
        })
      })
    }
  )

  server.tool("crm_update_lead",
    "Update an existing lead with validated properties",
    {
      leadId: z.string(),
      properties: leadPropertiesSchema
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = `/crm/v3/objects/leads/${params.leadId}`
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'PATCH', {
          properties: params.properties
        })
      })
    }
  )

  server.tool("crm_get_lead",
    "Get a single lead by ID with specific properties and associations",
    {
      leadId: z.string(),
      properties: z.array(z.string()).optional(),
      associations: z.array(z.enum(['companies', 'contacts', 'deals', 'notes', 'tasks'])).optional()
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = `/crm/v3/objects/leads/${params.leadId}`
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {
          properties: params.properties?.join(','),
          associations: params.associations?.join(',')
        })
      })
    }
  )

  server.tool("crm_search_leads",
    "Search leads with lead-specific filters",
    {
      filterGroups: z.array(z.object({
        filters: z.array(z.object({
          propertyName: z.string(),
          operator: z.enum(['EQ', 'NEQ', 'LT', 'LTE', 'GT', 'GTE', 'BETWEEN', 'IN', 'NOT_IN', 'HAS_PROPERTY', 'NOT_HAS_PROPERTY', 'CONTAINS_TOKEN', 'NOT_CONTAINS_TOKEN']),
          value: z.any()
        }))
      })),
      properties: z.array(z.string()).optional(),
      limit: z.number().min(1).max(100).optional(),
      after: z.string().optional(),
      sorts: z.array(z.object({
        propertyName: z.string(),
        direction: z.enum(['ASCENDING', 'DESCENDING'])
      })).optional()
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = '/crm/v3/objects/leads/search'
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'POST', {
          filterGroups: params.filterGroups,
          properties: params.properties,
          limit: params.limit,
          after: params.after,
          sorts: params.sorts
        })
      })
    }
  )

  server.tool("crm_batch_create_leads",
    "Create multiple leads in a single request",
    {
      inputs: z.array(z.object({
        properties: leadPropertiesSchema,
        associations: z.array(z.object({
          to: z.object({ id: z.string() }),
          types: z.array(z.object({
            associationCategory: z.string(),
            associationTypeId: z.number()
          }))
        })).optional()
      }))
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = '/crm/v3/objects/leads/batch/create'
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'POST', {
          inputs: params.inputs
        })
      })
    }
  )

  server.tool("crm_batch_update_leads",
    "Update multiple leads in a single request",
    {
      inputs: z.array(z.object({
        id: z.string(),
        properties: leadPropertiesSchema
      }))
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = '/crm/v3/objects/leads/batch/update'
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'POST', {
          inputs: params.inputs
        })
      })
    }
  )

  server.tool("crm_get_lead_properties",
    "Get all properties for leads",
    {
      archived: z.boolean().optional(),
      properties: z.array(z.string()).optional()
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = '/crm/v3/properties/leads'
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {
          archived: params.archived,
          properties: params.properties?.join(',')
        })
      })
    }
  )

  server.tool("crm_create_lead_property",
    "Create a new lead property",
    {
      name: z.string(),
      label: z.string(),
      type: z.enum(['string', 'number', 'date', 'datetime', 'enumeration', 'bool']),
      fieldType: z.enum(['text', 'textarea', 'select', 'radio', 'checkbox', 'number', 'date', 'file']),
      groupName: z.string(),
      description: z.string().optional(),
      options: z.array(z.object({
        label: z.string(),
        value: z.string(),
        description: z.string().optional(),
        displayOrder: z.number().optional(),
        hidden: z.boolean().optional()
      })).optional(),
      displayOrder: z.number().optional(),
      hasUniqueValue: z.boolean().optional(),
      hidden: z.boolean().optional(),
      formField: z.boolean().optional()
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = '/crm/v3/properties/leads'
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'POST', params)
      })
    }
  )

  // Meetings: https://developers.hubspot.com/docs/reference/api/crm/engagements/meetings

  server.tool("meetings_list",
    "List all meetings with optional filtering",
    {
      after: z.string().optional(),
      limit: z.number().min(1).max(100).optional(),
      createdAfter: z.string().optional(),
      createdBefore: z.string().optional(),
      properties: z.array(z.string()).optional()
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = '/crm/v3/objects/meetings'
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {
          after: params.after,
          limit: params.limit,
          createdAfter: params.createdAfter,
          createdBefore: params.createdBefore,
          properties: params.properties?.join(',')
        })
      })
    }
  )

  server.tool("meetings_get",
    "Get details of a specific meeting",
    {
      meetingId: z.string(),
      properties: z.array(z.string()).optional(),
      associations: z.array(z.enum(['contacts', 'companies', 'deals'])).optional()
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = `/crm/v3/objects/meetings/${params.meetingId}`
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {
          properties: params.properties?.join(','),
          associations: params.associations?.join(',')
        })
      })
    }
  )

  server.tool("meetings_create",
    "Create a new meeting",
    {
      properties: z.object({
        hs_timestamp: z.string(),
        hs_meeting_title: z.string(),
        hs_meeting_body: z.string().optional(),
        hs_meeting_location: z.string().optional(),
        hs_meeting_start_time: z.string(),
        hs_meeting_end_time: z.string(),
        hs_meeting_outcome: z.enum(['SCHEDULED', 'COMPLETED', 'CANCELED']).optional(),
        hubspot_owner_id: z.string().optional()
      }),
      associations: z.array(z.object({
        to: z.object({ id: z.string() }),
        types: z.array(z.object({
          associationCategory: z.string(),
          associationTypeId: z.number()
        }))
      })).optional()
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = '/crm/v3/objects/meetings'
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'POST', {
          properties: params.properties,
          associations: params.associations
        })
      })
    }
  )

  server.tool("meetings_update",
    "Update an existing meeting",
    {
      meetingId: z.string(),
      properties: z.object({
        hs_meeting_title: z.string().optional(),
        hs_meeting_body: z.string().optional(),
        hs_meeting_location: z.string().optional(),
        hs_meeting_start_time: z.string().optional(),
        hs_meeting_end_time: z.string().optional(),
        hs_meeting_outcome: z.enum(['SCHEDULED', 'COMPLETED', 'CANCELED']).optional(),
        hubspot_owner_id: z.string().optional()
      })
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = `/crm/v3/objects/meetings/${params.meetingId}`
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'PATCH', {
          properties: params.properties
        })
      })
    }
  )

  server.tool("meetings_archive",
    "Archive (delete) a meeting",
    {
      meetingId: z.string()
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = `/crm/v3/objects/meetings/${params.meetingId}`
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'DELETE')
      })
    }
  )

  server.tool("meetings_search",
    "Search meetings with specific filters",
    {
      filterGroups: z.array(z.object({
        filters: z.array(z.object({
          propertyName: z.string(),
          operator: z.enum(['EQ', 'NEQ', 'LT', 'LTE', 'GT', 'GTE', 'BETWEEN', 'IN', 'NOT_IN', 'HAS_PROPERTY', 'NOT_HAS_PROPERTY', 'CONTAINS_TOKEN', 'NOT_CONTAINS_TOKEN']),
          value: z.any()
        }))
      })),
      properties: z.array(z.string()).optional(),
      limit: z.number().min(1).max(100).optional(),
      after: z.string().optional(),
      sorts: z.array(z.object({
        propertyName: z.string(),
        direction: z.enum(['ASCENDING', 'DESCENDING'])
      })).optional()
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = '/crm/v3/objects/meetings/search'
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'POST', {
          filterGroups: params.filterGroups,
          properties: params.properties,
          limit: params.limit,
          after: params.after,
          sorts: params.sorts
        })
      })
    }
  )

  server.tool("meetings_batch_create",
    "Create multiple meetings in a single request",
    {
      inputs: z.array(z.object({
        properties: z.object({
          hs_timestamp: z.string(),
          hs_meeting_title: z.string(),
          hs_meeting_body: z.string().optional(),
          hs_meeting_location: z.string().optional(),
          hs_meeting_start_time: z.string(),
          hs_meeting_end_time: z.string(),
          hs_meeting_outcome: z.enum(['SCHEDULED', 'COMPLETED', 'CANCELED']).optional(),
          hubspot_owner_id: z.string().optional()
        }),
        associations: z.array(z.object({
          to: z.object({ id: z.string() }),
          types: z.array(z.object({
            associationCategory: z.string(),
            associationTypeId: z.number()
          }))
        })).optional()
      }))
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = '/crm/v3/objects/meetings/batch/create'
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'POST', {
          inputs: params.inputs
        })
      })
    }
  )

  server.tool("meetings_batch_update",
    "Update multiple meetings in a single request",
    {
      inputs: z.array(z.object({
        id: z.string(),
        properties: z.object({
          hs_meeting_title: z.string().optional(),
          hs_meeting_body: z.string().optional(),
          hs_meeting_location: z.string().optional(),
          hs_meeting_start_time: z.string().optional(),
          hs_meeting_end_time: z.string().optional(),
          hs_meeting_outcome: z.enum(['SCHEDULED', 'COMPLETED', 'CANCELED']).optional(),
          hubspot_owner_id: z.string().optional()
        })
      }))
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = '/crm/v3/objects/meetings/batch/update'
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'POST', {
          inputs: params.inputs
        })
      })
    }
  )

  server.tool("meetings_batch_archive",
    "Archive (delete) multiple meetings in a single request",
    {
      meetingIds: z.array(z.string()),
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = '/crm/v3/objects/meetings/batch/archive'
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'POST', {
          inputs: params.meetingIds.map((id: string) => ({ id }))
        })
      })
    }
  )

  // Notes: https://developers.hubspot.com/docs/reference/api/crm/engagements/notes

  const notePropertiesSchema = z.object({
    hs_note_body: z.string(),
    hs_timestamp: z.string().optional(),
    hubspot_owner_id: z.string().optional()
  }).catchall(z.any())

  server.tool("notes_create",
    "Create a new note",
    {
      properties: notePropertiesSchema,
      associations: z.array(z.object({
        to: z.object({ id: z.string() }),
        types: z.array(z.object({
          associationCategory: z.string(),
          associationTypeId: z.number()
        }))
      })).optional()
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = '/crm/v3/objects/notes'
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'POST', {
          properties: params.properties,
          associations: params.associations
        })
      })
    }
  )

  server.tool("notes_get",
    "Get details of a specific note",
    {
      noteId: z.string(),
      properties: z.array(z.string()).optional(),
      associations: z.array(z.enum(['contacts', 'companies', 'deals', 'tickets'])).optional()
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = `/crm/v3/objects/notes/${params.noteId}`
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {
          properties: params.properties?.join(','),
          associations: params.associations?.join(',')
        })
      })
    }
  )

  server.tool("notes_update",
    "Update an existing note",
    {
      noteId: z.string(),
      properties: notePropertiesSchema
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = `/crm/v3/objects/notes/${params.noteId}`
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'PATCH', {
          properties: params.properties
        })
      })
    }
  )

  server.tool("notes_archive",
    "Archive (delete) a note",
    {
      noteId: z.string()
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = `/crm/v3/objects/notes/${params.noteId}`
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'DELETE')
      })
    }
  )

  server.tool("notes_list",
    "List all notes with optional filtering",
    {
      limit: z.number().min(1).max(100).optional(),
      after: z.string().optional(),
      properties: z.array(z.string()).optional(),
      associations: z.array(z.enum(['contacts', 'companies', 'deals', 'tickets'])).optional(),
      archived: z.boolean().optional()
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = '/crm/v3/objects/notes'
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {
          limit: params.limit,
          after: params.after,
          properties: params.properties?.join(','),
          associations: params.associations?.join(','),
          archived: params.archived
        })
      })
    }
  )

  server.tool("notes_search",
    "Search notes with specific filters",
    {
      filterGroups: z.array(z.object({
        filters: z.array(z.object({
          propertyName: z.string(),
          operator: z.enum(['EQ', 'NEQ', 'LT', 'LTE', 'GT', 'GTE', 'BETWEEN', 'IN', 'NOT_IN', 'HAS_PROPERTY', 'NOT_HAS_PROPERTY', 'CONTAINS_TOKEN', 'NOT_CONTAINS_TOKEN']),
          value: z.any()
        }))
      })),
      properties: z.array(z.string()).optional(),
      limit: z.number().min(1).max(100).optional(),
      after: z.string().optional(),
      sorts: z.array(z.object({
        propertyName: z.string(),
        direction: z.enum(['ASCENDING', 'DESCENDING'])
      })).optional()
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = '/crm/v3/objects/notes/search'
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'POST', {
          filterGroups: params.filterGroups,
          properties: params.properties,
          limit: params.limit,
          after: params.after,
          sorts: params.sorts
        })
      })
    }
  )

  server.tool("notes_batch_create",
    "Create multiple notes in a single request",
    {
      inputs: z.array(z.object({
        properties: notePropertiesSchema,
        associations: z.array(z.object({
          to: z.object({ id: z.string() }),
          types: z.array(z.object({
            associationCategory: z.string(),
            associationTypeId: z.number()
          }))
        })).optional()
      }))
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = '/crm/v3/objects/notes/batch/create'
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'POST', {
          inputs: params.inputs
        })
      })
    }
  )

  server.tool("notes_batch_read",
    "Read multiple notes in a single request",
    {
      inputs: z.array(z.object({
        id: z.string(),
        properties: z.array(z.string()).optional(),
        associations: z.array(z.enum(['contacts', 'companies', 'deals', 'tickets'])).optional()
      }))
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = '/crm/v3/objects/notes/batch/read'
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'POST', {
          inputs: params.inputs
        })
      })
    }
  )

  server.tool("notes_batch_update",
    "Update multiple notes in a single request",
    {
      inputs: z.array(z.object({
        id: z.string(),
        properties: notePropertiesSchema
      }))
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = '/crm/v3/objects/notes/batch/update'
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'POST', {
          inputs: params.inputs
        })
      })
    }
  )

  server.tool("notes_batch_archive",
    "Archive (delete) multiple notes in a single request",
    {
      noteIds: z.array(z.string()),
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = '/crm/v3/objects/notes/batch/archive'
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'POST', {
          inputs: params.noteIds.map((id: string) => ({ id }))
        })
      })
    }
  )

  // Tasks: https://developers.hubspot.com/docs/reference/api/crm/engagements/tasks

  const taskPropertiesSchema = z.object({
    hs_task_body: z.string(),
    hs_task_priority: z.enum(['HIGH', 'MEDIUM', 'LOW']).optional(),
    hs_task_status: z.enum(['NOT_STARTED', 'IN_PROGRESS', 'WAITING', 'COMPLETED', 'DEFERRED']).optional(),
    hs_task_subject: z.string(),
    hs_task_type: z.string().optional(),
    hs_timestamp: z.string().optional(),
    hs_task_due_date: z.string().optional(),
    hubspot_owner_id: z.string().optional()
  }).catchall(z.any())

  server.tool("tasks_create",
    "Create a new task",
    {
      properties: taskPropertiesSchema,
      associations: z.array(z.object({
        to: z.object({ id: z.string() }),
        types: z.array(z.object({
          associationCategory: z.string(),
          associationTypeId: z.number()
        }))
      })).optional()
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = '/crm/v3/objects/tasks'
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'POST', {
          properties: params.properties,
          associations: params.associations
        })
      })
    }
  )

  server.tool("tasks_get",
    "Get details of a specific task",
    {
      taskId: z.string(),
      properties: z.array(z.string()).optional(),
      associations: z.array(z.enum(['contacts', 'companies', 'deals', 'tickets'])).optional()
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = `/crm/v3/objects/tasks/${params.taskId}`
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {
          properties: params.properties?.join(','),
          associations: params.associations?.join(',')
        })
      })
    }
  )

  server.tool("tasks_update",
    "Update an existing task",
    {
      taskId: z.string(),
      properties: taskPropertiesSchema
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = `/crm/v3/objects/tasks/${params.taskId}`
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'PATCH', {
          properties: params.properties
        })
      })
    }
  )

  server.tool("tasks_archive",
    "Archive (delete) a task",
    {
      taskId: z.string()
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = `/crm/v3/objects/tasks/${params.taskId}`
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'DELETE')
      })
    }
  )

  server.tool("tasks_list",
    "List all tasks with optional filtering",
    {
      limit: z.number().min(1).max(100).optional(),
      after: z.string().optional(),
      properties: z.array(z.string()).optional(),
      associations: z.array(z.enum(['contacts', 'companies', 'deals', 'tickets'])).optional(),
      archived: z.boolean().optional()
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = '/crm/v3/objects/tasks'
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {
          limit: params.limit,
          after: params.after,
          properties: params.properties?.join(','),
          associations: params.associations?.join(','),
          archived: params.archived
        })
      })
    }
  )

  server.tool("tasks_search",
    "Search tasks with specific filters",
    {
      filterGroups: z.array(z.object({
        filters: z.array(z.object({
          propertyName: z.string(),
          operator: z.enum(['EQ', 'NEQ', 'LT', 'LTE', 'GT', 'GTE', 'BETWEEN', 'IN', 'NOT_IN', 'HAS_PROPERTY', 'NOT_HAS_PROPERTY', 'CONTAINS_TOKEN', 'NOT_CONTAINS_TOKEN']),
          value: z.any()
        }))
      })),
      properties: z.array(z.string()).optional(),
      limit: z.number().min(1).max(100).optional(),
      after: z.string().optional(),
      sorts: z.array(z.object({
        propertyName: z.string(),
        direction: z.enum(['ASCENDING', 'DESCENDING'])
      })).optional()
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = '/crm/v3/objects/tasks/search'
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'POST', {
          filterGroups: params.filterGroups,
          properties: params.properties,
          limit: params.limit,
          after: params.after,
          sorts: params.sorts
        })
      })
    }
  )

  server.tool("tasks_batch_create",
    "Create multiple tasks in a single request",
    {
      inputs: z.array(z.object({
        properties: taskPropertiesSchema,
        associations: z.array(z.object({
          to: z.object({ id: z.string() }),
          types: z.array(z.object({
            associationCategory: z.string(),
            associationTypeId: z.number()
          }))
        })).optional()
      }))
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = '/crm/v3/objects/tasks/batch/create'
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'POST', {
          inputs: params.inputs
        })
      })
    }
  )

  server.tool("tasks_batch_read",
    "Read multiple tasks in a single request",
    {
      inputs: z.array(z.object({
        id: z.string(),
        properties: z.array(z.string()).optional(),
        associations: z.array(z.enum(['contacts', 'companies', 'deals', 'tickets'])).optional()
      }))
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = '/crm/v3/objects/tasks/batch/read'
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'POST', {
          inputs: params.inputs
        })
      })
    }
  )

  server.tool("tasks_batch_update",
    "Update multiple tasks in a single request",
    {
      inputs: z.array(z.object({
        id: z.string(),
        properties: taskPropertiesSchema
      }))
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = '/crm/v3/objects/tasks/batch/update'
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'POST', {
          inputs: params.inputs
        })
      })
    }
  )

  server.tool("tasks_batch_archive",
    "Archive (delete) multiple tasks in a single request",
    {
      taskIds: z.array(z.string()),
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = '/crm/v3/objects/tasks/batch/archive'
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'POST', {
          inputs: params.taskIds.map((id: string) => ({ id }))
        })
      })
    }
  )

  // Engagement Details: https://developers.hubspot.com/docs/reference/api/crm/engagements/engagement-details

  const engagementDetailsSchema = z.object({
    type: z.enum(['EMAIL', 'CALL', 'MEETING', 'TASK', 'NOTE']),
    title: z.string(),
    description: z.string().optional(),
    owner: z.object({
      id: z.string(),
      email: z.string().email()
    }).optional(),
    startTime: z.string().optional(),
    endTime: z.string().optional(),
    activityType: z.string().optional(),
    loggedAt: z.string().optional(),
    status: z.string().optional()
  }).catchall(z.any())

  server.tool("engagement_details_get",
    "Get details of a specific engagement",
    {
      engagementId: z.string()
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = `/engagements/v1/engagements/${params.engagementId}`
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint)
      })
    }
  )

  server.tool("engagement_details_create",
    "Create a new engagement with details",
    {
      engagement: engagementDetailsSchema,
      associations: z.object({
        contactIds: z.array(z.string()).optional(),
        companyIds: z.array(z.string()).optional(),
        dealIds: z.array(z.string()).optional(),
        ownerIds: z.array(z.string()).optional(),
        ticketIds: z.array(z.string()).optional()
      }).optional(),
      metadata: z.record(z.any()).optional()
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = '/engagements/v1/engagements'
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'POST', {
          engagement: params.engagement,
          associations: params.associations,
          metadata: params.metadata
        })
      })
    }
  )

  server.tool("engagement_details_update",
    "Update an existing engagement's details",
    {
      engagementId: z.string(),
      engagement: engagementDetailsSchema,
      metadata: z.record(z.any()).optional()
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = `/engagements/v1/engagements/${params.engagementId}`
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'PATCH', {
          engagement: params.engagement,
          metadata: params.metadata
        })
      })
    }
  )

  server.tool("engagement_details_list",
    "List all engagements with optional filtering",
    {
      limit: z.number().min(1).max(100).optional(),
      offset: z.number().optional(),
      startTime: z.string().optional(),
      endTime: z.string().optional(),
      activityTypes: z.array(z.string()).optional()
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = '/engagements/v1/engagements/paged'
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {
          limit: params.limit,
          offset: params.offset,
          startTime: params.startTime,
          endTime: params.endTime,
          activityTypes: params.activityTypes?.join(',')
        })
      })
    }
  )

  server.tool("engagement_details_archive",
    "Archive (delete) an engagement",
    {
      engagementId: z.string()
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = `/engagements/v1/engagements/${params.engagementId}`
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'DELETE')
      })
    }
  )

  server.tool("engagement_details_get_associated",
    "Get all engagements/activities (calls, emails, meetings, notes, tasks) associated with an object",
    {
      objectType: z.preprocess(
        (val) => {
          if (typeof val === 'string') {
            const upper = val.trim().toUpperCase();
            if (upper.startsWith('CONTACT')) return 'CONTACT';
            if (upper.startsWith('COMPAN')) return 'COMPANY';
            if (upper.startsWith('DEAL')) return 'DEAL';
            if (upper.startsWith('TICKET')) return 'TICKET';
          }
          return val;
        },
        z.enum(['CONTACT', 'COMPANY', 'DEAL', 'TICKET'])
      ),
      objectId: z.string(),
      startTime: z.string().optional(),
      endTime: z.string().optional(),
      activityTypes: z.array(z.string()).optional(),
      limit: z.number().min(1).max(100).optional(),
      offset: z.number().optional()
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = `/engagements/v1/engagements/associated/${params.objectType}/${params.objectId}/paged`
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {
          startTime: params.startTime,
          endTime: params.endTime,
          activityTypes: params.activityTypes?.join(','),
          limit: params.limit,
          offset: params.offset
        })
      })
    }
  )

  // Calls: https://developers.hubspot.com/docs/reference/api/crm/engagements/calls

  const callPropertiesSchema = z.object({
    hs_call_body: z.string(),
    hs_call_direction: z.enum(['INBOUND', 'OUTBOUND']).optional(),
    hs_call_disposition: z.string().optional(),
    hs_call_duration: z.number().optional(),
    hs_call_recording_url: z.string().url().optional(),
    hs_call_status: z.enum(['SCHEDULED', 'COMPLETED', 'CANCELED', 'NO_ANSWER']).optional(),
    hs_call_title: z.string(),
    hs_timestamp: z.string().optional(),
    hubspot_owner_id: z.string().optional()
  }).catchall(z.any())

  server.tool("calls_create",
    "Create a new call record",
    {
      properties: callPropertiesSchema,
      associations: z.array(z.object({
        to: z.object({ id: z.string() }),
        types: z.array(z.object({
          associationCategory: z.string(),
          associationTypeId: z.number()
        }))
      })).optional()
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = '/crm/v3/objects/calls'
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'POST', {
          properties: params.properties,
          associations: params.associations
        })
      })
    }
  )

  server.tool("calls_get",
    "Get details of a specific call",
    {
      callId: z.string(),
      properties: z.array(z.string()).optional(),
      associations: z.array(z.enum(['contacts', 'companies', 'deals', 'tickets'])).optional()
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = `/crm/v3/objects/calls/${params.callId}`
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {
          properties: params.properties?.join(','),
          associations: params.associations?.join(',')
        })
      })
    }
  )

  server.tool("calls_update",
    "Update an existing call record",
    {
      callId: z.string(),
      properties: callPropertiesSchema
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = `/crm/v3/objects/calls/${params.callId}`
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'PATCH', {
          properties: params.properties
        })
      })
    }
  )

  server.tool("calls_archive",
    "Archive (delete) a call record",
    {
      callId: z.string()
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = `/crm/v3/objects/calls/${params.callId}`
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'DELETE')
      })
    }
  )

  server.tool("calls_list",
    "List all calls with optional filtering",
    {
      limit: z.number().min(1).max(100).optional(),
      after: z.string().optional(),
      properties: z.array(z.string()).optional(),
      associations: z.array(z.enum(['contacts', 'companies', 'deals', 'tickets'])).optional(),
      archived: z.boolean().optional()
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = '/crm/v3/objects/calls'
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {
          limit: params.limit,
          after: params.after,
          properties: params.properties?.join(','),
          associations: params.associations?.join(','),
          archived: params.archived
        })
      })
    }
  )

  server.tool("calls_search",
    "Search calls with specific filters",
    {
      filterGroups: z.array(z.object({
        filters: z.array(z.object({
          propertyName: z.string(),
          operator: z.enum(['EQ', 'NEQ', 'LT', 'LTE', 'GT', 'GTE', 'BETWEEN', 'IN', 'NOT_IN', 'HAS_PROPERTY', 'NOT_HAS_PROPERTY', 'CONTAINS_TOKEN', 'NOT_CONTAINS_TOKEN']),
          value: z.any()
        }))
      })),
      properties: z.array(z.string()).optional(),
      limit: z.number().min(1).max(100).optional(),
      after: z.string().optional(),
      sorts: z.array(z.object({
        propertyName: z.string(),
        direction: z.enum(['ASCENDING', 'DESCENDING'])
      })).optional()
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = '/crm/v3/objects/calls/search'
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'POST', {
          filterGroups: params.filterGroups,
          properties: params.properties,
          limit: params.limit,
          after: params.after,
          sorts: params.sorts
        })
      })
    }
  )

  server.tool("calls_batch_create",
    "Create multiple call records in a single request",
    {
      inputs: z.array(z.object({
        properties: callPropertiesSchema,
        associations: z.array(z.object({
          to: z.object({ id: z.string() }),
          types: z.array(z.object({
            associationCategory: z.string(),
            associationTypeId: z.number()
          }))
        })).optional()
      }))
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = '/crm/v3/objects/calls/batch/create'
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'POST', {
          inputs: params.inputs
        })
      })
    }
  )

  server.tool("calls_batch_read",
    "Read multiple call records in a single request",
    {
      inputs: z.array(z.object({
        id: z.string(),
        properties: z.array(z.string()).optional(),
        associations: z.array(z.enum(['contacts', 'companies', 'deals', 'tickets'])).optional()
      }))
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = '/crm/v3/objects/calls/batch/read'
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'POST', {
          inputs: params.inputs
        })
      })
    }
  )

  server.tool("calls_batch_update",
    "Update multiple call records in a single request",
    {
      inputs: z.array(z.object({
        id: z.string(),
        properties: callPropertiesSchema
      }))
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = '/crm/v3/objects/calls/batch/update'
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'POST', {
          inputs: params.inputs
        })
      })
    }
  )

  server.tool("calls_batch_archive",
    "Archive (delete) multiple call records in a single request",
    {
      callIds: z.array(z.string()),
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = '/crm/v3/objects/calls/batch/archive'
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'POST', {
          inputs: params.callIds.map((id: string) => ({ id }))
        })
      })
    }
  )

  // Email: https://developers.hubspot.com/docs/reference/api/crm/engagements/email

  const emailPropertiesSchema = z.object({
    hs_email_subject: z.string(),
    hs_email_text: z.string(),
    hs_email_html: z.string().optional(),
    hs_email_status: z.enum(['SENT', 'DRAFT', 'SCHEDULED']).optional(),
    hs_email_direction: z.enum(['INBOUND', 'OUTBOUND']).optional(),
    hs_timestamp: z.string().optional(),
    hs_email_headers: z.record(z.string()).optional(),
    hs_email_from_email: z.string().email(),
    hs_email_from_firstname: z.string().optional(),
    hs_email_from_lastname: z.string().optional(),
    hs_email_to_email: z.string().email(),
    hs_email_to_firstname: z.string().optional(),
    hs_email_to_lastname: z.string().optional(),
    hs_email_cc: z.array(z.string().email()).optional(),
    hs_email_bcc: z.array(z.string().email()).optional(),
    hubspot_owner_id: z.string().optional()
  }).catchall(z.any())

  server.tool("emails_create",
    "Create a new email record",
    {
      properties: emailPropertiesSchema,
      associations: z.array(z.object({
        to: z.object({ id: z.string() }),
        types: z.array(z.object({
          associationCategory: z.string(),
          associationTypeId: z.number()
        }))
      })).optional()
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = '/crm/v3/objects/emails'
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'POST', {
          properties: params.properties,
          associations: params.associations
        })
      })
    }
  )

  server.tool("emails_get",
    "Get details of a specific email",
    {
      emailId: z.string(),
      properties: z.array(z.string()).optional(),
      associations: z.array(z.enum(['contacts', 'companies', 'deals', 'tickets'])).optional()
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = `/crm/v3/objects/emails/${params.emailId}`
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {
          properties: params.properties?.join(','),
          associations: params.associations?.join(',')
        })
      })
    }
  )

  server.tool("emails_update",
    "Update an existing email record",
    {
      emailId: z.string(),
      properties: emailPropertiesSchema
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = `/crm/v3/objects/emails/${params.emailId}`
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'PATCH', {
          properties: params.properties
        })
      })
    }
  )

  server.tool("emails_archive",
    "Archive (delete) an email record",
    {
      emailId: z.string()
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = `/crm/v3/objects/emails/${params.emailId}`
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'DELETE')
      })
    }
  )

  server.tool("emails_list",
    "List all emails with optional filtering",
    {
      limit: z.number().min(1).max(100).optional(),
      after: z.string().optional(),
      properties: z.array(z.string()).optional(),
      associations: z.array(z.enum(['contacts', 'companies', 'deals', 'tickets'])).optional(),
      archived: z.boolean().optional()
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = '/crm/v3/objects/emails'
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {
          limit: params.limit,
          after: params.after,
          properties: params.properties?.join(','),
          associations: params.associations?.join(','),
          archived: params.archived
        })
      })
    }
  )

  server.tool("emails_search",
    "Search emails with specific filters",
    {
      filterGroups: z.array(z.object({
        filters: z.array(z.object({
          propertyName: z.string(),
          operator: z.enum(['EQ', 'NEQ', 'LT', 'LTE', 'GT', 'GTE', 'BETWEEN', 'IN', 'NOT_IN', 'HAS_PROPERTY', 'NOT_HAS_PROPERTY', 'CONTAINS_TOKEN', 'NOT_CONTAINS_TOKEN']),
          value: z.any()
        }))
      })),
      properties: z.array(z.string()).optional(),
      limit: z.number().min(1).max(100).optional(),
      after: z.string().optional(),
      sorts: z.array(z.object({
        propertyName: z.string(),
        direction: z.enum(['ASCENDING', 'DESCENDING'])
      })).optional()
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = '/crm/v3/objects/emails/search'
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'POST', {
          filterGroups: params.filterGroups,
          properties: params.properties,
          limit: params.limit,
          after: params.after,
          sorts: params.sorts
        })
      })
    }
  )

  server.tool("emails_batch_create",
    "Create multiple email records in a single request",
    {
      inputs: z.array(z.object({
        properties: emailPropertiesSchema,
        associations: z.array(z.object({
          to: z.object({ id: z.string() }),
          types: z.array(z.object({
            associationCategory: z.string(),
            associationTypeId: z.number()
          }))
        })).optional()
      }))
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = '/crm/v3/objects/emails/batch/create'
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'POST', {
          inputs: params.inputs
        })
      })
    }
  )

  server.tool("emails_batch_read",
    "Read multiple email records in a single request",
    {
      inputs: z.array(z.object({
        id: z.string(),
        properties: z.array(z.string()).optional(),
        associations: z.array(z.enum(['contacts', 'companies', 'deals', 'tickets'])).optional()
      }))
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = '/crm/v3/objects/emails/batch/read'
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'POST', {
          inputs: params.inputs
        })
      })
    }
  )

  server.tool("emails_batch_update",
    "Update multiple email records in a single request",
    {
      inputs: z.array(z.object({
        id: z.string(),
        properties: emailPropertiesSchema
      }))
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = '/crm/v3/objects/emails/batch/update'
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'POST', {
          inputs: params.inputs
        })
      })
    }
  )

  server.tool("emails_batch_archive",
    "Archive (delete) multiple email records in a single request",
    {
      emailIds: z.array(z.string()),
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = '/crm/v3/objects/emails/batch/archive'
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'POST', {
          inputs: params.emailIds.map((id: string) => ({ id }))
        })
      })
    }
  )

  // Communications: https://developers.hubspot.com/docs/reference/api/crm/engagements/communications

  const communicationPreferencesSchema = z.object({
    subscriptionId: z.string(),
    status: z.enum(['SUBSCRIBED', 'UNSUBSCRIBED', 'NOT_OPTED']),
    legalBasis: z.enum(['LEGITIMATE_INTEREST_CLIENT', 'LEGITIMATE_INTEREST_PUB', 'PERFORMANCE_OF_CONTRACT', 'CONSENT_WITH_NOTICE', 'CONSENT_WITH_NOTICE_AND_OPT_OUT']).optional(),
    legalBasisExplanation: z.string().optional()
  }).catchall(z.any())

  server.tool("communications_get_preferences",
    "Get communication preferences for a contact",
    {
      contactId: z.string(),
      subscriptionId: z.string().optional()
    },
    async (params) => {
      return handleEndpoint(async () => {
        const subscriptionEndpointPath = params.subscriptionId ? `/subscription/${params.subscriptionId}` : ''
        const endpoint = `/communication-preferences/v3/status/email/${params.contactId}${subscriptionEndpointPath}`
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint)
      })
    }
  )

  server.tool("communications_update_preferences",
    "Update communication preferences for a contact",
    {
      contactId: z.string(),
      subscriptionId: z.string(),
      preferences: communicationPreferencesSchema
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = `/communication-preferences/v3/status/email/${params.contactId}/subscription/${params.subscriptionId}`
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'PUT', params.preferences)
      })
    }
  )

  server.tool("communications_unsubscribe_contact",
    "Unsubscribe a contact from all email communications",
    {
      contactId: z.string(),
      portalSubscriptionLegalBasis: z.enum(['LEGITIMATE_INTEREST_CLIENT', 'LEGITIMATE_INTEREST_PUB', 'PERFORMANCE_OF_CONTRACT', 'CONSENT_WITH_NOTICE', 'CONSENT_WITH_NOTICE_AND_OPT_OUT']).optional(),
      portalSubscriptionLegalBasisExplanation: z.string().optional()
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = `/communication-preferences/v3/unsubscribe/email/${params.contactId}`
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'PUT', {
          portalSubscriptionLegalBasis: params.portalSubscriptionLegalBasis,
          portalSubscriptionLegalBasisExplanation: params.portalSubscriptionLegalBasisExplanation
        })
      })
    }
  )

  server.tool("communications_subscribe_contact",
    "Subscribe a contact to all email communications",
    {
      contactId: z.string(),
      portalSubscriptionLegalBasis: z.enum(['LEGITIMATE_INTEREST_CLIENT', 'LEGITIMATE_INTEREST_PUB', 'PERFORMANCE_OF_CONTRACT', 'CONSENT_WITH_NOTICE', 'CONSENT_WITH_NOTICE_AND_OPT_OUT']).optional(),
      portalSubscriptionLegalBasisExplanation: z.string().optional()
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = `/communication-preferences/v3/subscribe/email/${params.contactId}`
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'PUT', {
          portalSubscriptionLegalBasis: params.portalSubscriptionLegalBasis,
          portalSubscriptionLegalBasisExplanation: params.portalSubscriptionLegalBasisExplanation
        })
      })
    }
  )

  server.tool("communications_get_subscription_definitions",
    "Get all subscription definitions for the portal",
    {
      archived: z.boolean().optional()
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = '/communication-preferences/v3/definitions'
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {
          archived: params.archived
        })
      })
    }
  )

  server.tool("communications_get_subscription_status",
    "Get subscription status for multiple contacts",
    {
      subscriptionId: z.string(),
      contactIds: z.array(z.string())
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = `/communication-preferences/v3/status/email/subscription/${params.subscriptionId}/bulk`
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'POST', {
          contactIds: params.contactIds
        })
      })
    }
  )

  server.tool("communications_update_subscription_status",
    "Update subscription status for multiple contacts",
    {
      subscriptionId: z.string(),
      updates: z.array(z.object({
        contactId: z.string(),
        status: z.enum(['SUBSCRIBED', 'UNSUBSCRIBED', 'NOT_OPTED']),
        legalBasis: z.enum(['LEGITIMATE_INTEREST_CLIENT', 'LEGITIMATE_INTEREST_PUB', 'PERFORMANCE_OF_CONTRACT', 'CONSENT_WITH_NOTICE', 'CONSENT_WITH_NOTICE_AND_OPT_OUT']).optional(),
        legalBasisExplanation: z.string().optional()
      }))
    },
    async (params) => {
      return handleEndpoint(async () => {
        const endpoint = `/communication-preferences/v3/status/email/subscription/${params.subscriptionId}/bulk`
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'PUT', {
          updates: params.updates
        })
      })
    }
  )

  // Products: https://developers.hubspot.com/docs/reference/api/crm/objects/products

  const productPropertiesSchema = z.object({
    name: z.string().optional(),
    description: z.string().optional(),
    price: z.number().optional(),
    sku: z.string().optional(),
    hs_product_type: z.string().optional(),
    hs_recurring_billing_period: z.string().optional(),
  }).catchall(z.any())

  server.tool("products_list",
    "Read a page of products. Control what is returned via the `properties` query param. `after` is the paging cursor token of the last successfully read resource will be returned as the `paging.next.after` JSON property of a paged response containing more results.",
    {
      limit: z.number().min(1).optional(),
      after: z.string().optional(),
      properties: z.array(z.string()).optional()
    },
    async params => handleEndpoint(async () => {
      const endpoint = '/crm/v3/objects/products'
      return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {
        limit: params.limit,
        after: params.after,
        properties: params.properties?.join(',')
      })
    })
  )

  server.tool("products_read",
    "Read an Object identified by ID",
    {
      productId: z.string(),
      properties: z.array(z.string()).optional(),
      associations: z.array(z.string()).optional()
    },
    async params => handleEndpoint(async () => {
      const endpoint = `/crm/v3/objects/products/${params.productId}`
      return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {
        properties: params.properties?.join(','),
        associations: params.associations?.join(',')
      })
    })
  )

  server.tool("products_create",
    "Create a product with the given properties and return a copy of the object, including the ID.",
    { properties: productPropertiesSchema },
    async params => handleEndpoint(async () => {
      const endpoint = '/crm/v3/objects/products'
      return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'POST', { properties: params.properties })
    })
  )

  server.tool("products_update",
    "Perform a partial update of an Object identified by ID. Read-only and non-existent properties will result in an error. Properties values can be cleared by passing an empty string.",
    { productId: z.string(), properties: productPropertiesSchema    },
    async params => handleEndpoint(async () => {
      const endpoint = `/crm/v3/objects/products/${params.productId}`
      return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'PATCH', { properties: params.properties })
    })
  )

  server.tool("products_archive",
    "Move an Object identified by ID to the recycling bin.",
    { productId: z.string() },
    async params => handleEndpoint(async () => {
      const endpoint = `/crm/v3/objects/products/${params.productId}`
      return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'DELETE')
    })
  )

  server.tool("products_search",
    "Search products",
    {
      query: z.string().optional(),
      limit: z.number().min(1).optional(),
      after: z.string().optional(),
      sorts: z.array(z.string()).optional(),
      properties: z.array(z.string()).optional(),
      filterGroups: z.array(z.object({
        filters: z.array(z.object({
          propertyName: z.string(),
          operator: z.enum(['EQ', 'NEQ', 'LT', 'LTE', 'GT', 'GTE', 'BETWEEN', 'IN', 'NOT_IN', 'HAS_PROPERTY', 'NOT_HAS_PROPERTY', 'CONTAINS_TOKEN', 'NOT_CONTAINS_TOKEN']),
          value: z.any().optional(),
          values: z.array(z.any()).optional()
        }))
      })),
    },
    async params => handleEndpoint(async () => {
      const endpoint = '/crm/v3/objects/products/search'
      return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'POST', {
        filterGroups: params.filterGroups,
        properties: params.properties,
        limit: params.limit,
        after: params.after,
        sorts: params.sorts
      })
    })
  )

  server.tool("products_batch_archive",
    "Archive (delete) a batch of products by ID",
    {
      productIds: z.array(z.string()),
    },
    async params => handleEndpoint(async () => {
      const endpoint = '/crm/v3/objects/products/batch/archive'
      return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'POST', { inputs: params.productIds.map((id: string) => ({ id })) })
    })
  )

  server.tool("products_batch_create",
    "Create a batch of products",
    {
      inputs: z.array(z.object({ properties: productPropertiesSchema }))
    },
    async params => handleEndpoint(async () => {
      const endpoint = '/crm/v3/objects/products/batch/create'
      return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'POST', { inputs: params.inputs })
    })
  )

  server.tool("products_batch_read",
    "Read a batch of products by internal ID, or unique property values. Retrieve records by the `idProperty` parameter to retrieve records by a custom unique value property.",
    {
      propertiesWithHistory: z.array(z.string()),
      idProperty: z.string().optional(),
      productIds: z.array(z.string()),
      properties: z.array(z.string())
    },
    async params => handleEndpoint(async () => {
      const endpoint = '/crm/v3/objects/products/batch/read'
      return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'POST', { inputs: params.productIds.map((id: string) => ({ id })) })
    })
  )

  server.tool("products_batch_update",
    "Update a batch of products by internal ID, or unique values specified by the `idProperty` query param.",
    {
      inputs: z.array(z.object({
        id: z.string(),
        idProperty: z.string().optional(),
        objectWriteTraceId: z.string().optional(),
        properties: productPropertiesSchema
      }))
    },
    async params => handleEndpoint(async () => {
      const endpoint = '/crm/v3/objects/products/batch/update'
      return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'POST', { inputs: params.inputs })
    })
  )

  // ==========================================
  // Conversations API (Messenger / Live Chat)
  // ==========================================

  async function resolveThreadsForContact(token: string, contactIdOrEmail: string, limit = 50): Promise<{ threads: any[], allVids: string[] }> {
    if (!token || !contactIdOrEmail) return { threads: [], allVids: [] }
    const allVids = new Set<string>()
    try {
      const isEmail = contactIdOrEmail.includes("@")
      const queryParams: Record<string, string> = {
        properties: "hs_all_contact_vids,hs_merged_object_ids,email"
      }
      if (isEmail) queryParams.idProperty = "email"

      const queryStr = new URLSearchParams(queryParams).toString()
      const contactUrl = `https://api.hubapi.com/crm/v3/objects/contacts/${encodeURIComponent(contactIdOrEmail)}?${queryStr}`
      const contactRes = await fetch(contactUrl, {
        headers: {
          'Accept': 'application/json',
          'Authorization': `Bearer ${token}`
        }
      })
      if (contactRes.ok) {
        const contactData: any = await contactRes.json()
        if (contactData.id) allVids.add(String(contactData.id))
        if (contactData.properties?.hs_all_contact_vids) {
          contactData.properties.hs_all_contact_vids.split(";").map((v: string) => v.trim()).filter(Boolean).forEach((v: string) => allVids.add(v))
        }
        if (contactData.properties?.hs_merged_object_ids) {
          contactData.properties.hs_merged_object_ids.split(";").map((v: string) => v.trim()).filter(Boolean).forEach((v: string) => allVids.add(v))
        }
      }
    } catch {
      // ignore
    }

    if (allVids.size === 0) allVids.add(contactIdOrEmail)

    const threadsMap = new Map<string, any>()
    for (const vid of allVids) {
      try {
        const threadUrl = `https://api.hubapi.com/conversations/v3/conversations/threads?associatedContactId=${encodeURIComponent(vid)}`
        const threadRes = await fetch(threadUrl, {
          headers: {
            'Accept': 'application/json',
            'Authorization': `Bearer ${token}`
          }
        })
        if (threadRes.ok) {
          const threadData: any = await threadRes.json()
          for (const t of (threadData.results || [])) {
            threadsMap.set(t.id, t)
          }
        }
      } catch {
        // ignore
      }
    }

    const threads = Array.from(threadsMap.values()).sort((a, b) => {
      const tA = new Date(a.latestMessageTimestamp || a.createdAt || 0).getTime()
      const tB = new Date(b.latestMessageTimestamp || b.createdAt || 0).getTime()
      return tB - tA
    })

    return { threads: threads.slice(0, limit), allVids: Array.from(allVids) }
  }

  // --- HubSpot Conversations Helpers & Anti-Duplication Engine ---

  function getMessageTimestamp(msg: any): number {
    if (!msg) return 0
    const raw = msg.createdAt ?? msg.timestamp ?? msg.createdDate ?? 0
    if (typeof raw === 'number') return raw
    const num = Number(raw)
    if (!isNaN(num) && num > 1000000000) return num
    const parsed = new Date(raw).getTime()
    return isNaN(parsed) ? 0 : parsed
  }

  function extractMessagesList(raw: any): any[] {
    if (!raw) return []
    if (Array.isArray(raw)) return raw
    if (typeof raw === 'object') {
      if (Array.isArray(raw.results)) return raw.results
      if (Array.isArray(raw.messages)) return raw.messages
    }
    return []
  }

  function sortMessages(messages: any[], direction: 'ASCENDING' | 'DESCENDING' = 'ASCENDING'): any[] {
    if (!Array.isArray(messages)) return []
    const isDesc = String(direction).toUpperCase() === 'DESCENDING'
    return [...messages].sort((a, b) => {
      const tA = getMessageTimestamp(a)
      const tB = getMessageTimestamp(b)
      return isDesc ? tB - tA : tA - tB
    })
  }

  function applySortToMessagesResult(result: any, sort: 'ASCENDING' | 'DESCENDING' = 'DESCENDING'): any {
    if (!result || typeof result !== 'object') return result
    if (Array.isArray(result)) {
      return sortMessages(result, sort)
    }
    if (Array.isArray(result.results)) {
      return {
        ...result,
        results: sortMessages(result.results, sort)
      }
    }
    if (Array.isArray(result.messages)) {
      return {
        ...result,
        messages: sortMessages(result.messages, sort)
      }
    }
    return result
  }

  function isCustomerMessage(msg: any): boolean {
    if (!msg) return false
    if (typeof msg.direction === 'string') {
      return msg.direction.toUpperCase() === 'INCOMING'
    }
    const actorId = msg.senders?.[0]?.actorId || msg.createdBy || msg.actorId || ''
    if (typeof actorId === 'string') {
      if (actorId.startsWith('V-') || actorId.toUpperCase().includes('VISITOR')) return true
      if (actorId.startsWith('A-') || actorId.toUpperCase().includes('AGENT')) return false
    }
    return false
  }

  function isAgentMessage(msg: any): boolean {
    if (!msg) return false
    if (typeof msg.direction === 'string') {
      return msg.direction.toUpperCase() === 'OUTGOING'
    }
    const actorId = msg.senders?.[0]?.actorId || msg.createdBy || msg.actorId || ''
    if (typeof actorId === 'string') {
      if (actorId.startsWith('A-') || actorId.startsWith('B-') || actorId.toUpperCase().includes('AGENT') || actorId.toUpperCase().includes('BOT') || actorId.toUpperCase().includes('USER')) return true
      if (actorId.startsWith('V-') || actorId.toUpperCase().includes('VISITOR')) return false
    }
    return false
  }

  const CLOSING_PHRASES = [
    'oki', 'ok', 'oke', 'okie', 'ok nè', 'oki b an', 'oki bạn nè', 'oki bạn', 'oki b', 'ok b', 'ok bạn', 'ok shop', 'ok nhé', 'ok nha',
    'ạ', 'da', 'dạ', 'dạ vâng', 'vang', 'vâng', 'cảm ơn', 'cam on', 'cảm ơn bạn', 'cảm ơn shop',
    'thanks', 'thank you', 'tks', 'thank', 'da cam on', 'dạ cảm ơn',
    'đây nha', 'đây nha bạn', 'đây bạn', 'đây nè', 'đây nè bạn', 'đây nhé', 'đây ạ', 'đây shop', 'đây',
    'nè bạn', 'nè shop', 'nè ad', 'nè bồ', 'nè ní', 'nè',
    'xem giúp', 'xem giùm', 'xem hộ', 'xem giúp mình', 'xem giùm mình', 'xem hộ mình', 'check giúp', 'check giùm',
    'gửi bạn', 'gửi nè', 'gửi shop', 'đã gửi', 'mình gửi', 'em gửi', 'rồi nha', 'xong rồi', 'xong rùi'
  ]

  const BURST_FOLLOWUP_REGEX = /^(đây\s*(nha|nhé|nè|ạ|ah|nhe|bạn|shop|bồ|ní)?|nè\s*(bạn|shop|ad|bồ|ní)?|xem\s*(giúp|giùm|hộ)(\s*mình|\s*em|\s*bạn)?|check\s*(giúp|giùm|hộ)|(mình|em|tui)?\s*gửi\s*(nè|ạ|nha|bạn|shop)?|(đã|mới)\s*gửi|(ok|oki|oke|okie)(\s*(nha|nhé|nè|ạ|ah|nhe|bạn|shop|ad|bồ|ní|b|roi|rồi))?|dạ|ạ|vâng|rồi\s*(nha|nhé|ạ|rùi)|xong\s*(rồi|rùi))$/i

  function isAcknowledgementMessage(text: string): boolean {
    if (!text || typeof text !== 'string') return false
    const cleaned = text.trim().toLowerCase().replace(/[.!?,;:~-]+$/g, '').trim()
    return CLOSING_PHRASES.includes(cleaned) || BURST_FOLLOWUP_REGEX.test(cleaned)
  }

  function getMessageText(msg: any): string {
    if (!msg || typeof msg !== 'object') return ''
    if (typeof msg.text === 'string' && msg.text.trim()) return msg.text.trim()
    if (typeof msg.body === 'string' && msg.body.trim()) return msg.body.trim()
    if (typeof msg.richText === 'string' && msg.richText.trim()) {
      return msg.richText.replace(/<[^>]*>/g, '').trim()
    }
    return ''
  }

  function computeAntiDuplicationContext(
    input: any,
    optionsOrCurrentText: {
      targetMessageId?: string
      currentMessageText?: string
      enableAckDetection?: boolean
    } | string = {}
  ) {
    const options = typeof optionsOrCurrentText === 'string'
      ? { currentMessageText: optionsOrCurrentText }
      : (optionsOrCurrentText || {})

    const rawList = extractMessagesList(input)
    const sortedAsc = sortMessages(rawList, 'ASCENDING')

    const customerMessages: any[] = []
    const agentMessages: any[] = []

    for (const msg of sortedAsc) {
      if (isCustomerMessage(msg)) {
        customerMessages.push(msg)
      } else if (isAgentMessage(msg)) {
        agentMessages.push(msg)
      }
    }

    const lastAgentReply = agentMessages.length > 0 ? agentMessages[agentMessages.length - 1] : null
    const lastCustomerMessage = customerMessages.length > 0 ? customerMessages[customerMessages.length - 1] : null
    const lastAgentTime = lastAgentReply ? getMessageTimestamp(lastAgentReply) : 0
    const lastAgentText = lastAgentReply ? getMessageText(lastAgentReply) : ''

    // SIMULTANEOUS_TOLERANCE_MS: In real-time chat, messages sent within a few seconds of agent response
    // or before it are considered already addressed or near-simultaneous
    const SIMULTANEOUS_TOLERANCE_MS = 5000

    // Unreplied customer messages: sent strictly AFTER the latest agent message (+ tolerance)
    const unrepliedCustomerMessages = customerMessages.filter(msg => {
      return getMessageTimestamp(msg) > (lastAgentTime + SIMULTANEOUS_TOLERANCE_MS)
    })

    const newCustomerMessagesSinceLastReply = unrepliedCustomerMessages.length

    // Check targetMessageId (e.g. from background queue worker)
    let targetMessage: any = null
    let targetMessageAddressed: boolean | null = null

    if (options.targetMessageId) {
      targetMessage = rawList.find(m => m.id === options.targetMessageId) || null
      if (targetMessage) {
        const targetTime = getMessageTimestamp(targetMessage)
        targetMessageAddressed = lastAgentReply ? (targetTime <= lastAgentTime + SIMULTANEOUS_TOLERANCE_MS) : false
      }
    }

    // Check echo / repetition of currentMessageText
    let isCurrentMessageEcho = false
    if (options.currentMessageText && lastAgentText) {
      const curNorm = options.currentMessageText.trim().toLowerCase()
      const agNorm = lastAgentText.trim().toLowerCase()
      if (curNorm.length > 0 && (curNorm === agNorm || agNorm.includes(curNorm) || curNorm.includes(agNorm))) {
        isCurrentMessageEcho = true
      }
    }

    let allRecentCustomerMessagesAddressed: boolean
    let needsReply: boolean
    let recommendedAction: 'REPLY' | 'NO_REPLY'
    let reason: string

    if (isCurrentMessageEcho) {
      allRecentCustomerMessagesAddressed = true
      needsReply = false
      recommendedAction = 'NO_REPLY'
      reason = 'Nội dung tin nhắn trùng khớp với phản hồi gần nhất của Agent (outgoing echo/phản hồi lặp lại).'
    } else if (targetMessage) {
      if (targetMessageAddressed) {
        allRecentCustomerMessagesAddressed = true
        needsReply = false
        recommendedAction = 'NO_REPLY'
        reason = `Target message '${options.targetMessageId}' (sent ${new Date(getMessageTimestamp(targetMessage)).toISOString()}) has already been addressed by agent reply '${lastAgentReply.id}' sent at ${new Date(lastAgentTime).toISOString()}.`
      } else {
        allRecentCustomerMessagesAddressed = false
        needsReply = true
        recommendedAction = 'REPLY'
        reason = `Target message '${options.targetMessageId}' was sent AFTER the last agent reply and requires attention.`
      }
    } else {
      if (customerMessages.length === 0) {
        allRecentCustomerMessagesAddressed = true
        needsReply = false
        recommendedAction = 'NO_REPLY'
        reason = 'No customer messages in thread.'
      } else if (!lastAgentReply) {
        allRecentCustomerMessagesAddressed = false
        needsReply = true
        recommendedAction = 'REPLY'
        reason = `Customer has sent ${customerMessages.length} message(s) with no prior agent replies.`
      } else if (newCustomerMessagesSinceLastReply === 0) {
        allRecentCustomerMessagesAddressed = true
        needsReply = false
        recommendedAction = 'NO_REPLY'
        const isNearSimultaneous = customerMessages.some(m => {
          const t = getMessageTimestamp(m)
          return t > lastAgentTime && t <= (lastAgentTime + SIMULTANEOUS_TOLERANCE_MS)
        })
        reason = isNearSimultaneous
          ? `Tất cả tin nhắn khách hàng gần đây đều có timestamp trước hoặc gần như đồng thời (trong vòng 5s) so với thời điểm Agent phản hồi '${lastAgentReply.id}' lúc ${new Date(lastAgentTime).toISOString()}, và Agent đã có nội dung trả lời.`
          : `All recent customer messages were sent prior to agent reply '${lastAgentReply.id}' sent at ${new Date(lastAgentTime).toISOString()}. No new messages from customer since.`
      } else {
        allRecentCustomerMessagesAddressed = false
        needsReply = true
        recommendedAction = 'REPLY'
        reason = `Customer sent ${newCustomerMessagesSinceLastReply} new message(s) since last agent reply at ${new Date(lastAgentTime).toISOString()}.`
      }
    }

    // Check if the only pending message or current message text is a brief courtesy acknowledgement / burst follow-up
    let isClosingRemark = false
    if (options.enableAckDetection && lastAgentReply) {
      if (options.currentMessageText && isAcknowledgementMessage(options.currentMessageText)) {
        isClosingRemark = true
        allRecentCustomerMessagesAddressed = true
        needsReply = false
        recommendedAction = 'NO_REPLY'
        reason = `Incoming/candidate message ("${options.currentMessageText}") is a courtesy acknowledgment or burst follow-up for prior agent reply sent at ${new Date(lastAgentTime).toISOString()}. No further reply needed.`
      } else if (needsReply && unrepliedCustomerMessages.length === 1) {
        const pendingText = getMessageText(unrepliedCustomerMessages[0])
        if (isAcknowledgementMessage(pendingText)) {
          isClosingRemark = true
          allRecentCustomerMessagesAddressed = true
          needsReply = false
          recommendedAction = 'NO_REPLY'
          reason = `Customer message '${unrepliedCustomerMessages[0].id}' is a courtesy closing remark or burst follow-up ("${pendingText}"). No further reply needed.`
        }
      }
    }

    const lastAgentSummary = lastAgentReply ? {
      id: lastAgentReply.id,
      text: lastAgentText,
      createdAt: lastAgentReply.createdAt || lastAgentReply.timestamp,
      createdBy: lastAgentReply.createdBy,
      direction: lastAgentReply.direction,
      timestamp: lastAgentTime
    } : null

    const lastCustomerSummary = lastCustomerMessage ? {
      id: lastCustomerMessage.id,
      text: getMessageText(lastCustomerMessage),
      createdAt: lastCustomerMessage.createdAt || lastCustomerMessage.timestamp,
      createdBy: lastCustomerMessage.createdBy,
      direction: lastCustomerMessage.direction,
      timestamp: getMessageTimestamp(lastCustomerMessage)
    } : null

    const unrepliedFormatted = unrepliedCustomerMessages.map(m => ({
      id: m.id,
      text: getMessageText(m),
      createdAt: m.createdAt || m.timestamp,
      createdBy: m.createdBy,
      direction: m.direction,
      timestamp: getMessageTimestamp(m)
    }))

    const guidance = recommendedAction === 'NO_REPLY'
      ? `[ANTI-DUPLICATION NOTICE] This message or topic has already been addressed by agent reply at ${lastAgentReply ? new Date(lastAgentTime).toISOString() : 'N/A'}. Do NOT send a duplicate message. Return NO_REPLY. Nếu câu hỏi/ý kiến của khách đã được giải quyết trong lastAgentMessage, LLM BẮT BUỘC trả về NO_REPLY để tránh lặp lại thông điệp (chẳng hạn chúc an toàn lặp lại, chào lặp lại).`
      : `Khách hàng có tin nhắn mới cần giải quyết. Tin nhắn mới nhất: "${unrepliedFormatted[unrepliedFormatted.length - 1]?.text}". LLM cần tập trung trả lời đúng câu hỏi mới, TUYỆT ĐỐI KHÔNG lặp lại câu chúc hoặc câu chào đã gửi trong tin nhắn trước của Agent ("${lastAgentText.slice(0, 100)}..."). Nếu ý kiến của khách đã được giải quyết trọn vẹn, LLM BẮT BUỘC trả về NO_REPLY.`

    const alreadyAddressedGuidance = recommendedAction === 'NO_REPLY' ? guidance : null

    return {
      allRecentCustomerMessagesAddressed,
      needsReply,
      recommendedAction,
      reason,
      isClosingRemark,
      totalMessages: sortedAsc.length,
      newCustomerMessagesSinceLastReply,
      lastAgentMessage: lastAgentSummary,
      lastAgentReply: lastAgentSummary,
      lastCustomerMessage: lastCustomerSummary,
      unrepliedCustomerMessages: unrepliedFormatted,
      unrepliedMessages: unrepliedFormatted,
      guidance,
      alreadyAddressedGuidance
    }
  }

  server.tool(
    "conversations_get_thread_messages",
    "Retrieve all messages from a conversation thread (e.g. Facebook Messenger, live chat, email) in HubSpot Inbox. Returns sender, text content, timestamps, message direction, and antiDuplicationContext. Note: threadId MUST be a HubSpot conversation thread ID (e.g. '11207036290'). Do NOT pass a CRM Contact ID or email here. If you only have a contact ID/email, use conversations_list_threads or conversations_get_contact_messages first. (If a contact ID/email is mistakenly passed, this tool will attempt to auto-resolve to the contact's latest conversation thread).",
    {
      threadId: z.string().describe("The HubSpot conversation thread ID (e.g. '11207036290')"),
      limit: z.number().optional().describe("Maximum number of messages to return (max 100)"),
      sort: z.enum(["ASCENDING", "DESCENDING"]).optional().describe("Sort messages by creation timestamp (default DESCENDING)")
    },
    async (params) => handleEndpoint(async () => {
      const endpoint = `/conversations/v3/conversations/threads/${params.threadId}/messages`
      const queryParams: Record<string, any> = {}
      if (params.limit !== undefined) queryParams.limit = params.limit
      // DO NOT pass sort to queryParams: HubSpot endpoint returns 400 Bad Request if sort query param is passed
      const result = await makeApiRequest(hubspotAccessToken, endpoint, queryParams, 'GET')

      // Auto-fallback: If 404, check if params.threadId is actually a contact ID or email
      if (typeof result === 'string' && result.includes('Status 404')) {
        const { threads: contactThreads } = await resolveThreadsForContact(hubspotAccessToken, params.threadId)
        if (contactThreads.length > 0) {
          const latestThread = contactThreads[0]
          const resolvedEndpoint = `/conversations/v3/conversations/threads/${latestThread.id}/messages`
          const threadMsgResult = await makeApiRequest(hubspotAccessToken, resolvedEndpoint, queryParams, 'GET')
          const sortedThreadMsgResult = applySortToMessagesResult(threadMsgResult, params.sort || 'DESCENDING')
          const antiDuplicationContext = computeAntiDuplicationContext(sortedThreadMsgResult, { enableAckDetection: true })
          return formatResponse({
            notice: `[AUTO-RECOVERED] The provided threadId '${params.threadId}' was not found as a thread ID because it is a CRM Contact ID (or Email). Auto-resolved to this contact's latest active conversation thread '${latestThread.id}'. Total threads found for contact: ${contactThreads.length}.`,
            resolvedThreadId: latestThread.id,
            associatedContactId: latestThread.associatedContactId,
            channelId: latestThread.originalChannelId,
            allThreads: contactThreads.map((t: any) => ({
              threadId: t.id,
              associatedContactId: t.associatedContactId,
              channelId: t.originalChannelId,
              latestMessageTimestamp: t.latestMessageTimestamp
            })),
            messages: sortedThreadMsgResult,
            antiDuplicationContext
          })
        } else {
          return formatResponse({
            error: `Thread ID '${params.threadId}' was not found (Status 404). Note: If '${params.threadId}' is a Contact ID, this contact has no active Live Chat/Messenger conversation threads in HubSpot Inbox. To check email or engagement history, use crm_get_associations with toObjectType: 'emails' or 'notes'.`
          })
        }
      }

      if (typeof result === 'string') {
        return formatResponse(result)
      }

      const sortedResult = applySortToMessagesResult(result, params.sort || 'DESCENDING')
      const antiDuplicationContext = computeAntiDuplicationContext(sortedResult, { enableAckDetection: true })

      if (sortedResult && typeof sortedResult === 'object' && !Array.isArray(sortedResult)) {
        return formatResponse({
          ...sortedResult,
          antiDuplicationContext
        })
      }

      return formatResponse({
        messages: sortedResult,
        antiDuplicationContext
      })
    })
  )

  server.tool(
    "conversations_get_thread",
    "Get details of a specific conversation thread including channel ID, associated contact ID, inbox ID, and status. Note: threadId MUST be a HubSpot conversation thread ID (e.g. '11207036290'). Do NOT pass a CRM Contact ID or email here. If you only have a contact ID/email, use conversations_list_threads or conversations_get_contact_messages first.",
    {
      threadId: z.string().describe("The HubSpot conversation thread ID (e.g. '11207036290')")
    },
    async (params) => handleEndpoint(async () => {
      const endpoint = `/conversations/v3/conversations/threads/${params.threadId}`
      const result = await makeApiRequest(hubspotAccessToken, endpoint, {}, 'GET')

      if (typeof result === 'string' && result.includes('Status 404')) {
        const { threads: contactThreads } = await resolveThreadsForContact(hubspotAccessToken, params.threadId)
        if (contactThreads.length > 0) {
          const latestThread = contactThreads[0]
          return formatResponse({
            notice: `[AUTO-RECOVERED] The provided threadId '${params.threadId}' was not found as a thread ID because it is a CRM Contact ID (or Email). Auto-resolved to this contact's latest active conversation thread '${latestThread.id}'. Total threads found for contact: ${contactThreads.length}.`,
            resolvedThread: latestThread,
            allThreads: contactThreads.map((t: any) => ({
              threadId: t.id,
              associatedContactId: t.associatedContactId,
              channelId: t.originalChannelId,
              latestMessageTimestamp: t.latestMessageTimestamp
            }))
          })
        } else {
          return formatResponse({
            error: `Thread ID '${params.threadId}' was not found (Status 404). Note: If '${params.threadId}' is a Contact ID, this contact has no active Live Chat/Messenger conversation threads in HubSpot Inbox.`
          })
        }
      }

      return formatResponse(result)
    })
  )

  server.tool(
    "conversations_list_threads",
    "List conversation threads in HubSpot Conversations Inbox. Can filter by contact ID or email (associatedContactId). Automatically resolves and aggregates threads across all merged contact profiles (hs_all_contact_vids) sorted with latest active conversations first. Also automatically preloads recent messages and antiDuplicationContext from the latest active thread so you do not need to call another tool.",
    {
      associatedContactId: z.string().optional().describe("Filter threads by HubSpot contact ID or contact email. Automatically resolves merged contact profiles."),
      limit: z.number().optional().describe("Maximum number of threads to return (max 100)"),
      includeLatestMessages: z.boolean().optional().describe("Whether to include messages of the latest active thread directly in the response (default true)")
    },
    async (params) => handleEndpoint(async () => {
      if (params.associatedContactId) {
        const { threads, allVids } = await resolveThreadsForContact(hubspotAccessToken, params.associatedContactId, params.limit || 50)
        let latestThreadMessages: any = null
        let antiDuplicationContext: any = null
        const shouldIncludeMessages = params.includeLatestMessages !== false
        if (shouldIncludeMessages && threads.length > 0) {
          const latestThreadId = threads[0].id
          const msgEndpoint = `/conversations/v3/conversations/threads/${latestThreadId}/messages`
          // HubSpot messages endpoint does not accept sort param; request without sort, then sort in-memory
          const rawMessages = await makeApiRequest(hubspotAccessToken, msgEndpoint, { limit: 20 }, 'GET')
          latestThreadMessages = applySortToMessagesResult(rawMessages, 'DESCENDING')
          antiDuplicationContext = computeAntiDuplicationContext(latestThreadMessages, { enableAckDetection: true })
        }
        return formatResponse({
          notice: `All conversation threads across all merged contact profiles (${allVids.join(', ')}) are ALREADY aggregated in this result. DO NOT call conversations_list_threads again for any of these merged IDs. The latest thread '${threads[0]?.id}' messages are preloaded below in 'latestThreadMessages'.`,
          contactVidsResolved: allVids,
          total: threads.length,
          results: threads,
          latestThreadId: threads[0]?.id,
          latestThreadMessages: latestThreadMessages,
          antiDuplicationContext: antiDuplicationContext
        })
      }

      const endpoint = '/conversations/v3/conversations/threads'
      const queryParams: Record<string, any> = {}
      if (params.limit !== undefined) queryParams.limit = params.limit
      return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, queryParams, 'GET')
    })
  )

  server.tool(
    "conversations_get_contact_messages",
    "Retrieve conversation messages directly for a customer by contact ID or email across all channels (Facebook Messenger, Live Chat) in HubSpot. Đọc các đoạn hội thoại, tin nhắn chat của khách hàng. Automatically aggregates all threads across all merged contact profiles (hs_all_contact_vids) and returns messages and antiDuplicationContext from the most recent active conversation in a single call. Use this whenever asked to read conversation history, chat messages, or 'đọc các đoạn hội thoại của khách hàng' without needing a thread ID.",
    {
      contactIdOrEmail: z.string().describe("Customer HubSpot contact ID (e.g. '252745349968') or email (e.g. 'thecuongnguyen789@gmail.com')"),
      limit: z.number().optional().describe("Maximum number of messages to return (max 100, default 20)"),
      sort: z.enum(["ASCENDING", "DESCENDING"]).optional().describe("Sort messages by timestamp (default DESCENDING)")
    },
    async (params) => handleEndpoint(async () => {
      const { threads, allVids } = await resolveThreadsForContact(hubspotAccessToken, params.contactIdOrEmail, 50)
      if (threads.length === 0) {
        return formatResponse({
          notice: `No conversation threads found in HubSpot Conversations Inbox for contact '${params.contactIdOrEmail}' (checked VIDs: ${allVids.join(', ')}). Note: This contact has no Live Chat/Messenger inbox threads. To check email or engagement history in CRM, use crm_get_associations with toObjectType: 'emails' or 'notes'.`,
          contactVidsResolved: allVids,
          messages: [],
          antiDuplicationContext: computeAntiDuplicationContext([], { enableAckDetection: true })
        })
      }

      const latestThread = threads[0]
      const msgEndpoint = `/conversations/v3/conversations/threads/${latestThread.id}/messages`
      const queryParams: Record<string, any> = {}
      if (params.limit !== undefined) queryParams.limit = params.limit
      // DO NOT pass sort to queryParams
      const msgResult = await makeApiRequest(hubspotAccessToken, msgEndpoint, queryParams, 'GET')
      if (typeof msgResult === 'string') {
        return formatResponse(msgResult)
      }
      const sortedMsgResult = applySortToMessagesResult(msgResult, params.sort || 'DESCENDING')
      const antiDuplicationContext = computeAntiDuplicationContext(sortedMsgResult, { enableAckDetection: true })

      return formatResponse({
        notice: `Retrieved messages from latest active thread '${latestThread.id}' (channel: ${latestThread.originalChannelId}, contact VID: ${latestThread.associatedContactId}). All merged VIDs checked: ${allVids.join(', ')}. Total threads found: ${threads.length}.`,
        threadId: latestThread.id,
        channelId: latestThread.originalChannelId,
        associatedContactId: latestThread.associatedContactId,
        allThreads: threads.map((t: any) => ({
          threadId: t.id,
          associatedContactId: t.associatedContactId,
          channelId: t.originalChannelId,
          latestMessageTimestamp: t.latestMessageTimestamp
        })),
        messages: sortedMsgResult,
        antiDuplicationContext
      })
    })
  )

  server.tool(
    "conversations_check_reply_needed",
    "MANDATORY ANTI-DUPLICATION CHECK: Evaluate whether a conversation thread currently requires a reply from Agent/Bot or should return NO_REPLY. You MUST call this tool whenever a customer sends a short message (< 5 words), burst follow-up ('đây nha', 'nè bạn', 'xem giúp', 'ạ', 'dạ'), or when you are uncertain if the inquiry has already been answered. Analyzes recent incoming vs outgoing messages, compares timestamps, inspects the last agent message, and identifies unreplied customer inquiries.",
    {
      threadId: z.string().describe("The HubSpot conversation thread ID (or Contact ID / Email for auto-resolution)"),
      currentMessageText: z.string().optional().describe("The incoming message text or candidate reply to check against the last sent agent message to avoid echoes or burst duplicates")
    },
    async (params) => handleEndpoint(async () => {
      let actualThreadId = params.threadId
      const msgEndpoint = `/conversations/v3/conversations/threads/${actualThreadId}/messages`
      let msgResult = await makeApiRequest(hubspotAccessToken, msgEndpoint, { limit: 20 }, 'GET')

      // Auto-fallback: If 404 or threadId is contactId / email
      if (typeof msgResult === 'string' && msgResult.includes('Status 404')) {
        const { threads: contactThreads } = await resolveThreadsForContact(hubspotAccessToken, params.threadId)
        if (contactThreads.length > 0) {
          actualThreadId = contactThreads[0].id
          const resolvedEndpoint = `/conversations/v3/conversations/threads/${actualThreadId}/messages`
          msgResult = await makeApiRequest(hubspotAccessToken, resolvedEndpoint, { limit: 20 }, 'GET')
        } else {
          return formatResponse({
            threadId: params.threadId,
            needsReply: false,
            reason: `Thread ID '${params.threadId}' was not found (Status 404) and no conversation threads were found for this contact.`,
            recommendedAction: "NO_REPLY",
            allRecentCustomerMessagesAddressed: true,
            lastAgentMessage: null,
            lastAgentReply: null,
            unrepliedMessages: [],
            unrepliedCustomerMessages: [],
            guidance: "Không tìm thấy thread hoặc tin nhắn nào. Trả về NO_REPLY."
          })
        }
      }

      if (typeof msgResult === 'string') {
        return formatResponse({
          threadId: actualThreadId,
          error: msgResult
        })
      }

      const antiDup = computeAntiDuplicationContext(msgResult, {
        currentMessageText: params.currentMessageText,
        enableAckDetection: true
      })

      return formatResponse({
        threadId: actualThreadId,
        needsReply: antiDup.needsReply,
        reason: antiDup.reason,
        recommendedAction: antiDup.recommendedAction,
        allRecentCustomerMessagesAddressed: antiDup.allRecentCustomerMessagesAddressed,
        lastAgentMessage: antiDup.lastAgentMessage,
        lastAgentReply: antiDup.lastAgentReply,
        unrepliedMessages: antiDup.unrepliedMessages,
        unrepliedCustomerMessages: antiDup.unrepliedCustomerMessages,
        guidance: antiDup.guidance
      })
    })
  )

  return server.server
}

// Stdio Server 
const stdioServer = createServer({})
const transport = new StdioServerTransport()
await stdioServer.connect(transport)

// Streamable HTTP Server
const { app } = createStatefulServer(createServer)
const PORT = process.env.PORT || 3000
app.listen(PORT)
