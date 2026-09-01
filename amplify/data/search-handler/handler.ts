import {
  DynamoDBClient,
  SearchVectorsCommand,
} from "@aws-sdk/client-dynamodb";
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import type { Schema } from "../resource";

const TABLE_NAME = process.env.TABLE_NAME!;
const INDEX_NAME = process.env.INDEX_NAME!;
const EMBEDDING_MODEL_ID = process.env.EMBEDDING_MODEL_ID!;
const EMBEDDING_DIMENSIONS = parseInt(process.env.EMBEDDING_DIMENSIONS!, 10);
const LLM_MODEL_ID = process.env.LLM_MODEL_ID!;

const dynamodb = new DynamoDBClient({});
const bedrock = new BedrockRuntimeClient({});

// ── Types ───────────────────────────────────────────────────────────────

interface ParsedQuery {
  semanticQuery: string;
  maxPrice?: number;
  minPrice?: number;
  availableOnly?: boolean;
}

// ── Parse the user query with Nova Micro ────────────────────────────────

async function parseUserQuery(userQuery: string): Promise<ParsedQuery> {
  const systemPrompt = `You are a query parser for a product search engine. 
Given a user's natural language query, extract:
1. The semantic/descriptive part (what the user is looking for by meaning)
2. Any structured filters (price constraints, availability)

Respond ONLY with a JSON object, no other text:
{
  "semanticQuery": "the descriptive part for semantic search",
  "maxPrice": number or null,
  "minPrice": number or null,
  "availableOnly": true or null
}

Examples:
- "lightweight waterproof jacket under 200 euros" → {"semanticQuery":"lightweight waterproof jacket","maxPrice":200,"minPrice":null,"availableOnly":null}
- "warm sleeping bag for winter camping" → {"semanticQuery":"warm sleeping bag for winter camping","maxPrice":null,"minPrice":null,"availableOnly":null}
- "hiking boots between 100 and 250 dollars" → {"semanticQuery":"hiking boots","minPrice":100,"maxPrice":250,"availableOnly":null}`;

  const response = await bedrock.send(
    new InvokeModelCommand({
      modelId: LLM_MODEL_ID,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify({
        schemaVersion: "messages-v1",
        system: [{ text: systemPrompt }],
        messages: [{ role: "user", content: [{ text: userQuery }] }],
        inferenceConfig: {
          maxTokens: 200,
          temperature: 0,
        },
      }),
    })
  );

  const body = JSON.parse(new TextDecoder().decode(response.body));
  const text = body.output.message.content[0].text;

  try {
    // Extract JSON from the response (handle markdown code blocks)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON found");
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      semanticQuery: parsed.semanticQuery || userQuery,
      maxPrice: parsed.maxPrice ?? undefined,
      minPrice: parsed.minPrice ?? undefined,
      availableOnly: parsed.availableOnly ?? undefined,
    };
  } catch {
    // Fallback: use the entire query as semantic
    console.warn("Failed to parse LLM response, using raw query:", text);
    return { semanticQuery: userQuery };
  }
}

// ── Generate embedding ──────────────────────────────────────────────────

async function generateEmbedding(text: string): Promise<number[]> {
  const response = await bedrock.send(
    new InvokeModelCommand({
      modelId: EMBEDDING_MODEL_ID,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify({
        inputText: text,
        dimensions: EMBEDDING_DIMENSIONS,
        normalize: true,
      }),
    })
  );

  const body = JSON.parse(new TextDecoder().decode(response.body));
  return body.embedding;
}

// ── Handler ─────────────────────────────────────────────────────────────

export const handler: Schema["searchProducts"]["functionHandler"] = async (
  event
) => {
  const { query, topK = 10 } = event.arguments;

  // Step 1: Use Nova Micro to separate semantic query from structured filters
  const parsed = await parseUserQuery(query);
  console.log("Parsed query:", JSON.stringify(parsed));

  // Step 2: Generate embedding from the semantic part only
  const queryEmbedding = await generateEmbedding(parsed.semanticQuery);

  // Step 3: SearchVectors — fetch more results than needed so we can filter
  const searchVector = queryEmbedding.map((n) => ({ N: n.toString() }));

  const params: Record<string, unknown> = {
    TableName: TABLE_NAME,
    IndexName: INDEX_NAME,
    SearchVector: searchVector,
    TopK: Math.min((topK ?? 10) * 2, 100), // fetch extra to account for post-filtering
    ProjectionExpression:
      "ProductId, #n, Category, Description, Price, Available",
    ExpressionAttributeNames: {
      "#n": "Name",
    },
  };

  const result = await dynamodb.send(
    new SearchVectorsCommand(params as any)
  );

  // Step 4: Map results and apply structured filters
  let products = (result.SearchResults ?? []).map((r: any) => {
    const item = unmarshall(r.Item);
    return {
      productId: item.ProductId as string,
      name: item.Name as string,
      category: item.Category as string,
      description: item.Description as string,
      price: item.Price as number,
      available: item.Available as boolean,
      score: r.Score as number,
    };
  });

  // Apply price filters extracted by Nova Micro
  if (parsed.maxPrice != null) {
    products = products.filter((p) => p.price <= parsed.maxPrice!);
  }
  if (parsed.minPrice != null) {
    products = products.filter((p) => p.price >= parsed.minPrice!);
  }
  if (parsed.availableOnly) {
    products = products.filter((p) => p.available);
  }

  // Return only the requested number of results
  return {
    products: products.slice(0, topK ?? 10),
    parsedFilters: {
      semanticQuery: parsed.semanticQuery,
      maxPrice: parsed.maxPrice ?? null,
      minPrice: parsed.minPrice ?? null,
      availableOnly: parsed.availableOnly ?? null,
    },
  };
};
