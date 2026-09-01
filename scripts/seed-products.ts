/**
 * Seed script: reads products.json, generates embeddings via Bedrock,
 * and writes items (with embeddings) to the DynamoDB Products table.
 *
 * Usage:
 *   npx tsx scripts/seed-products.ts <TABLE_NAME> [--region us-east-1]
 *
 * The TABLE_NAME is printed by `npx ampx sandbox` or can be found
 * in amplify_outputs.json under custom.ProductsTableName.
 */
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  DynamoDBClient,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Parse CLI args ──────────────────────────────────────────────────────
const args = process.argv.slice(2);
const tableName = args.find((a) => !a.startsWith("--"));
const regionIdx = args.indexOf("--region");
const region = regionIdx !== -1 ? args[regionIdx + 1] : undefined;

if (!tableName) {
  console.error(
    "Usage: npx tsx scripts/seed-products.ts <TABLE_NAME> [--region us-east-1]"
  );
  process.exit(1);
}

const EMBEDDING_MODEL_ID = "amazon.titan-embed-text-v2:0";
const EMBEDDING_DIMENSIONS = 1024;

const dynamodb = new DynamoDBClient(region ? { region } : {});
const bedrock = new BedrockRuntimeClient(region ? { region } : {});

// ── Load products ───────────────────────────────────────────────────────
interface Product {
  ProductId: string;
  Name: string;
  Category: string;
  Description: string;
  Price: number;
  Available: boolean;
}

const products: Product[] = JSON.parse(
  readFileSync(join(__dirname, "products.json"), "utf-8")
);

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

// ── Write one product ───────────────────────────────────────────────────
async function writeProduct(product: Product, embedding: number[]) {
  // Build the item with the embedding stored as a DynamoDB L(ist) of N(umbers)
  const item = marshall(
    {
      ProductId: product.ProductId,
      Name: product.Name,
      Category: product.Category,
      Description: product.Description,
      Price: product.Price,
      Available: product.Available,
    },
    { removeUndefinedValues: true }
  );

  // Add the embedding as L type manually (marshall doesn't handle float arrays well for vectors)
  item.Embedding = {
    L: embedding.map((n) => ({ N: n.toString() })),
  };

  await dynamodb.send(
    new PutItemCommand({
      TableName: tableName,
      Item: item,
    })
  );
}

// ── Main ────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\nSeeding ${products.length} products into table: ${tableName}\n`);

  for (let i = 0; i < products.length; i++) {
    const product = products[i];
    const textToEmbed = `${product.Name}. ${product.Description}`;

    process.stdout.write(
      `[${i + 1}/${products.length}] ${product.Name} ... `
    );

    const embedding = await generateEmbedding(textToEmbed);
    await writeProduct(product, embedding);

    console.log(`done (${embedding.length} dims)`);

    // Small delay to avoid Bedrock throttling
    if (i < products.length - 1) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  console.log(`\n✓ All ${products.length} products seeded successfully.\n`);
}

main().catch((err) => {
  console.error("\nSeed failed:", err.message);
  process.exit(1);
});
