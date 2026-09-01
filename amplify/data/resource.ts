import { type ClientSchema, a, defineData, defineFunction } from "@aws-amplify/backend";
import { defineConversationHandlerFunction } from "@aws-amplify/backend-ai/conversation";

export const searchProductsHandler = defineFunction({
  name: "searchProducts",
  entry: "./search-handler/handler.ts",
  timeoutSeconds: 30,
  memoryMB: 256,
  runtime: 22,
  environment: {
    TABLE_NAME: "", // will be overridden in backend.ts
    INDEX_NAME: "ProductEmbeddingIndex",
    EMBEDDING_MODEL_ID: "amazon.titan-embed-text-v2:0",
    EMBEDDING_DIMENSIONS: "1024",
    LLM_MODEL_ID: "eu.amazon.nova-micro-v1:0",
  },
});

export const novaLiteModel = "amazon.nova-lite-v1:0";
export const crossRegionModel = `eu.${novaLiteModel}`;

export const chatHandler = defineConversationHandlerFunction({
  name: "chatHandler",
  entry: "./conversationHandler.ts",
  models: [{ modelId: crossRegionModel }],
});

const schema = a.schema({
  Product: a.customType({
    productId: a.string().required(),
    name: a.string().required(),
    category: a.string().required(),
    description: a.string().required(),
    price: a.float().required(),
    available: a.boolean().required(),
    score: a.float(),
  }),

  ParsedFilters: a.customType({
    semanticQuery: a.string().required(),
    maxPrice: a.float(),
    minPrice: a.float(),
    availableOnly: a.boolean(),
  }),

  SearchResult: a.customType({
    products: a.ref("Product").array().required(),
    parsedFilters: a.ref("ParsedFilters").required(),
  }),

  searchProducts: a
    .query()
    .arguments({
      query: a.string().required(),
      category: a.string(),
      topK: a.integer(),
    })
    .returns(a.ref("SearchResult"))
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(searchProductsHandler)),

  chat: a.conversation({
    aiModel: {
      resourcePath: crossRegionModel,
    },
    systemPrompt: `You are a helpful AI shopping assistant for an outdoor gear store. 
You help users find products by understanding what they need.
When a user describes what they're looking for, use the searchProducts tool to find relevant products.
Present the results in a friendly, conversational way, explaining why each product matches their needs.
If the user mentions a price constraint, include it in your search query so the tool can filter by price.
Always search before answering product questions — don't make up products.`,
    handler: chatHandler,
    tools: [
      a.ai.dataTool({
        name: "searchProducts",
        description:
          "Search the product catalog using natural language. The query should describe what the user is looking for. Include price constraints in the query text if mentioned. Returns semantically matched products.",
        query: a.ref("searchProducts"),
      }),
    ],
  })
    .authorization((allow) => allow.owner()),
});

export type Schema = ClientSchema<typeof schema>;

export const data = defineData({
  schema,
  authorizationModes: {
    defaultAuthorizationMode: "userPool",
  },
});
