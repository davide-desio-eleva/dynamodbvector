# DynamoDB Vector Search — Semantic Search + Voice Agent Demo

> Companion posts:
> - [Your database is an AI tool: semantic search with Amazon DynamoDB Vector Search](https://dev.to/aws-builders/your-database-is-an-ai-tool-semantic-search-with-amazon-dynamodb-vector-search-46ff)
> - Deploying the voice agent to Amazon Bedrock AgentCore Runtime (see [`blog-2.md`](./blog-2.md))

A sample application that shows how to use **Amazon DynamoDB native vector search** to build semantic search over application data, how to expose that capability to AI agents as a tool, and how to deploy a real-time voice agent for it on **Amazon Bedrock AgentCore Runtime** — all inside a single AWS Amplify Gen 2 backend.

It demonstrates the same idea through three interfaces:

1. **Search** — type a natural language query and get semantically matched products
2. **Chat** — a conversational AI assistant (Amplify AI Kit) that calls the search as a tool
3. **Voice** — a real-time voice agent (Strands + Amazon Nova 2 Sonic) that searches by speech, runnable locally or deployed to Amazon Bedrock AgentCore Runtime

> [!WARNING]
> **This project is experimental.** It was built to explain how DynamoDB Vector Search works and how to combine it with AI agents. It is **not production ready**: it skips hardening, error handling, cost controls, and security review that a real workload would need. Use it to learn from and to adapt, not to deploy as-is.

> Built with [Kiro](https://kiro.dev), an agentic AI development environment.

## The idea

Instead of syncing your data to a separate vector database, you store the embedding **next to** the application entity it represents. The product's price, availability, category, and its vector all live in the same DynamoDB item. Search then combines vector similarity with the operational attributes that already drive the app.

A user asks:

> "I'm going hiking in Iceland in October. I need something lightweight, waterproof and I'd like to stay under €250."

Behind the scenes the search does four things:

1. **Parse** the query with Amazon Nova Micro, splitting semantic intent (`lightweight waterproof hiking gear`) from structured filters (`price <= 250`)
2. **Embed** the semantic part with Amazon Titan Text Embeddings V2 (1024 dimensions)
3. **Search** the DynamoDB vector index with `SearchVectors` (cosine similarity)
4. **Filter** the results by the structured constraints, then return the top matches

## Architecture

```
                    Search UI          Chat UI          Voice UI
                        │                 │                 │
                        │                 │        WebSocket (PCM audio)
                        │                 │                 │
                        ▼                 ▼                 ▼
                  AppSync query    Amplify AI Kit    Strands BidiAgent
                        │           (Bedrock chat)   (Nova 2 Sonic)
                        │                 │                 │
                        └────────┬────────┴────────┬────────┘
                                 │                 │
                                 ▼                 │
                          searchProducts  ◄────────┘  (tool)
                                 │
              ┌──────────────────┼──────────────────┐
              ▼                  ▼                  ▼
        Nova Micro         Titan Embeddings   DynamoDB
        (parse query)      (embedding)        SearchVectors
                                              + post-filter
```

- **Search** goes through an Amplify Gen 2 custom query backed by a Lambda.
- **Chat** uses the Amplify AI Kit conversation route with the same query exposed as a data tool.
- **Voice** is a Python FastAPI server hosting a Strands `BidiAgent` with Nova 2 Sonic and the same search logic as a Python `@tool`. It runs locally during development, or gets deployed to **Amazon Bedrock AgentCore Runtime** as part of the same Amplify backend (containerized, WebSocket streaming, authenticated with the same Cognito user pool).

## Tech stack

- **Frontend**: React + Vite + TypeScript
- **Backend**: AWS Amplify Gen 2 (Auth, Data/AppSync, Lambda)
- **Vector store**: Amazon DynamoDB vector index (`SearchVectors` API)
- **Models**: Amazon Titan Text Embeddings V2, Amazon Nova Micro, Amazon Nova Lite (chat), Amazon Nova 2 Sonic (voice)
- **Voice agent**: Strands Agents (`BidiAgent`) + FastAPI, deployable on Amazon Bedrock AgentCore Runtime (ARM64 container built with CDK `DockerImageAsset`)

## Prerequisites

- Node.js 18+ and npm
- An AWS account with credentials configured (`aws configure`, SSO, or environment variables)
- AWS CLI v2.36.16+ (vector index support was added August 2026)
- Amazon Bedrock model access enabled in your region:
  - Titan Text Embeddings V2 and Nova Micro (used by search, in the table region)
  - Nova Lite (used by the chat assistant)
  - Nova 2 Sonic (used by the voice agent — check region availability)
- Python 3.12+ (only for running the voice agent locally)
- Docker (only to deploy the voice agent to AgentCore — CDK builds the ARM64 image)

## Getting started

### 1. Install dependencies

```bash
npm install
```

### 2. Deploy the Amplify backend (sandbox)

This provisions Cognito, AppSync, the DynamoDB table, the vector index (via a custom resource), the Lambda functions, and the voice agent on AgentCore Runtime (it builds the ARM64 container from `voice-agent/`, so Docker must be running). It also generates `amplify_outputs.json`.

```bash
npx ampx sandbox
```

Pick a region where your Bedrock models are available, for example:

```bash
npx ampx sandbox --profile default --region eu-west-1
```

Wait until the vector index reaches `ACTIVE`. Adding an index to a table triggers a backfill, and `SearchVectors` returns a validation error until it finishes.

### 3. Seed the product catalog

The table name is written to `amplify_outputs.json` under `custom.ProductsTableName`.

```bash
npx tsx scripts/seed-products.ts <TABLE_NAME> --region eu-west-1
```

This generates embeddings for the sample products and writes them to DynamoDB.

### 4. Run the frontend

```bash
npm run dev
```

Open the app, sign in (Cognito), and try the **Search** and **Chat** tabs.

### 5. Run the voice agent (optional, local)

In a separate terminal:

```bash
npm run dev:agent
```

The script reads the table name from `amplify_outputs.json` automatically (or pass it explicitly: `npm run dev:agent -- <TABLE_NAME>`). It starts a local WebSocket server on `ws://127.0.0.1:8080/ws`. Open the **Voice** tab, connect, and start talking.

> Use headphones for the voice agent to avoid audio feedback.

### Voice agent: local vs deployed

The frontend picks the voice endpoint automatically based on `amplify_outputs.json`:

- If `custom.VoiceAgentRuntimeArn` is present (the sandbox deployed the AgentCore Runtime), the browser connects to the **deployed** agent over a WebSocket authenticated with the signed-in user's Cognito token (passed via the `Sec-WebSocket-Protocol` subprotocol).
- Otherwise it falls back to the **local** agent on `ws://127.0.0.1:8080/ws` (the `npm run dev:agent` server above).

So `npm run dev:agent` is only needed when iterating on the agent locally. Once the sandbox has deployed the runtime, the **Voice** tab talks to AgentCore with no local server running.

## Project structure

```
├── amplify/                      # Amplify Gen 2 backend
│   ├── auth/resource.ts          # Cognito auth
│   ├── data/
│   │   ├── resource.ts           # AppSync schema, searchProducts query, chat conversation route
│   │   ├── search-handler/       # Lambda: parse → embed → SearchVectors → filter
│   │   └── conversationHandler.ts # Amplify AI Kit conversation handler
│   └── backend.ts                # CDK: DynamoDB table + vector index + IAM
├── scripts/
│   ├── products.json             # Sample product catalog
│   └── seed-products.ts          # Embeds and loads products into DynamoDB
├── src/                          # React frontend
│   ├── components/               # SearchBar, ProductCard, ChatView, VoiceView, ...
│   ├── hooks/useVoiceAgent.ts    # Microphone capture + WebSocket + audio playback
│   ├── voice-connection.ts       # Builds the local or AgentCore (signed) WebSocket URL
│   └── App.tsx                   # Search / Chat / Voice tabs
├── voice-agent/                  # Python voice agent (local + AgentCore container)
│   ├── agent.py                  # Strands BidiAgent + Nova 2 Sonic + search_products tool
│   ├── Dockerfile                # ARM64 image for AgentCore Runtime
│   ├── requirements.txt
│   └── start.sh
├── blog.md                       # Companion article 1: DynamoDB Vector Search
└── blog-2.md                     # Companion article 2: deploying the voice agent to AgentCore
```

## Notes on DynamoDB Vector Search

- Vector indexes require the table to use **on-demand** capacity mode.
- At the time of writing, CloudFormation does not support the `VectorIndexes` property, so the index is created with an SDK call (`UpdateTable`) via a CDK `AwsCustomResource`.
- `SearchConditionExpression` currently supports equality filters only. Range filters (like `price <= 200`) are applied in application code after the search, which is why the demo fetches more results than it returns.
- The query vector must come from the same embedding model and dimension count as the stored vectors.

## Notes on the AgentCore voice agent

- AgentCore Runtime expects an **ARM64** container listening on port 8080, exposing a WebSocket at `/ws` and a health check at `/ping`.
- The runtime protocol is `HTTP` (valid values: `HTTP`, `A2A`, `AGUI`, `MCP`). WebSocket bidirectional streaming runs on top of the HTTP server protocol — there is no `WEBSOCKET` protocol value.
- Inbound auth uses a JWT authorizer pointed at the Amplify Cognito user pool's OIDC discovery URL, so the same signed-in users can reach the agent.
- Browsers can't set custom headers on a WebSocket handshake, so the Cognito bearer token is passed via the `Sec-WebSocket-Protocol` subprotocol (base64url-encoded).

## Cleanup

To tear down the AWS resources:

```bash
npx ampx sandbox delete
```

## Related

Two companion articles walk through this project:

- [`blog.md`](./blog.md) — DynamoDB Vector Search, semantic search, and exposing it to an AI agent as a tool ([original post on dev.to](https://dev.to/aws-builders/your-database-is-an-ai-tool-semantic-search-with-amazon-dynamodb-vector-search-46ff))
- [`blog-2.md`](./blog-2.md) — Deploying a real-time voice agent with AgentCore Runtime and Amplify Gen 2 ([original post on dev.to](https://dev.to/aws-builders/deploying-a-real-time-voice-agent-with-agentcore-runtime-and-amplify-gen-2-45bl))
