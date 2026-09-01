# 🏃 TL;DR

It's been a while since I wrote an article that wasn't about [KiroGraph](https://github.com/davide-desio-eleva/kirograph)! 

Lately, I've been playing with AI agents quite a lot, and one question in particular has caught my attention: how do we make agents useful when the information they need isn't sitting in a knowledge base, but directly inside an application?

Let's take something very simple: imagine an e-commerce application with products, prices, categories, inventory and descriptions, nothing particularly special. The application is already running, and DynamoDB is already storing all this information.

**Now we add an AI shopping assistant.**

A user doesn't necessarily want to search using product names or exact keywords. They might say:

> "I'm going hiking in Iceland in October. I need something lightweight, waterproof and I'd like to stay under €250."

This is where things get interesting: the user isn't really telling us what words to search for, but what they're looking for. And that's exactly the kind of problem where semantic search can make a big difference.

`Amazon DynamoDB` now has **native vector search**, which means we can store embeddings alongside our application data and use it to retrieve items based on their semantic similarity.

So instead of adding a separate vector database just because our AI application needs semantic retrieval, we can ask a different question: **What if the database that already stores our application data could also be the vector database?**

That's what I want to explore in this article.

And then, once we have that capability, we'll make it available to an AI agent as a **tool**.

## 🔍 Why semantic search for application data?

Let's start with the problem rather than the technology.

Suppose our `DynamoDB` table contains products like this:

```json
{
  "productId": "JACKET-123",
  "name": "StormShield Alpine Jacket",
  "category": "outdoor",
  "description": "Lightweight waterproof shell designed for hiking in cold and rainy conditions.",
  "price": 189,
  "available": true
}
```

A user asking for:

> "Something lightweight for hiking in Iceland in October"

might never mention the words "shell" or "rainy conditions". But we know what they mean, and that gap is exactly what separates keyword search from semantic search.

With keyword search, we're mostly asking:

> "Does this item contain the words I'm looking for?"

While using vector search, we're asking:

> "How close is this item to what the user is actually asking for?"

**To do that, we need to represent the product as a vector.**
We can generate an embedding from its name, description and other relevant textual attributes and store that embedding together with the product in `DynamoDB`.

The item now contains both the information the application needs and the information the semantic search needs.

Conceptually our `DynamoDB` record would be:

```text
Product
 ├── name
 ├── description
 ├── category
 ├── price
 ├── availability
 └── embedding
```

This is the first thing that makes `DynamoDB Vector Search` interesting to me: **the vector isn't some external representation of a document, rather it's another representation of an entity that already belongs to the application.**

## 🔄 What DynamoDB Vector Search changes

If you've built RAG systems before, this architecture might look very familiar. We usually end up with something like:

![Image description](https://dev-to-uploads.s3.us-east-2.amazonaws.com/uploads/articles/86pv7h2k78w3b705cyw1.png)


There is nothing inherently wrong with this: a dedicated vector or search database can be exactly the right choice depending on the workload. But there is a fundamental difference when our vectors represent application entities.

Take our product: it has description, price, category, inventory state, availability. With `DynamoDB Vector Search`, we can keep the vector representation next to those attributes and use them together when searching.

So our search isn't just:

> "Find products similar to this text."

It can become:

> "Find products semantically similar to this request, where the price is below €250 and the product is currently available."

That's a much more useful query for an application, and it's where `DynamoDB Vector Search` becomes more than just a way to store embeddings: it lets us combine **vector similarity with the operational attributes that already drive the application**.

## 🏗️ Setting up the table and vector index

Let's look at what it takes to set this up in practice: a DynamoDB table in on-demand capacity mode (required for vector indexes), and a vector index on top of it.

At the time of writing, CloudFormation doesn't support the `VectorIndexes` property yet, so we create the table first and then add the vector index via the `UpdateTable` API. In our sample application we use AWS CDK with an `AwsCustomResource` to make this SDK call as part of the deployment:

```typescript
const productsTable = new dynamodb.Table(dataStack, "ProductsTable", {
  partitionKey: { name: "ProductId", type: dynamodb.AttributeType.STRING },
  billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
});

new cr.AwsCustomResource(dataStack, "CreateVectorIndex", {
  onCreate: {
    service: "DynamoDB",
    action: "updateTable",
    parameters: {
      TableName: productsTable.tableName,
      VectorIndexUpdates: [{
        Create: {
          IndexName: "ProductEmbeddingIndex",
          VectorAttribute: { AttributeName: "Embedding" },
          Projection: { ProjectionType: "ALL" },
          Dimensions: 1024,
          DistanceFunction: "COSINE",
        },
      }],
    },
    physicalResourceId: cr.PhysicalResourceId.of("ProductEmbeddingIndex"),
  },
  // ...
});
```

A few things to note:

- **Dimensions: 1024** matches the output of Amazon Titan Text Embeddings V2, which is the model we use to generate embeddings.
- **DistanceFunction: COSINE** means lower scores indicate greater similarity (0 = identical, 2 = opposite direction).
- **Projection: ALL** makes every attribute available in search results, so we can return product details directly from the vector search without a second read.

Once the index is `ACTIVE`, we can store vectors alongside our products and search them.

![Image description](https://dev-to-uploads.s3.us-east-2.amazonaws.com/uploads/articles/2vk0bbnaqnfwsyv948y9.png)

## 📦 Storing products with embeddings

Writing a product with its vector embedding is a normal DynamoDB `PutItem` call. The embedding is stored as a list of numbers (`L` type containing `N` elements):

```typescript
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";

const bedrock = new BedrockRuntimeClient({});
const dynamodb = new DynamoDBClient({});

// Generate an embedding from the product text
const response = await bedrock.send(new InvokeModelCommand({
  modelId: "amazon.titan-embed-text-v2:0",
  contentType: "application/json",
  accept: "application/json",
  body: JSON.stringify({
    inputText: "StormShield Alpine Jacket. Lightweight waterproof shell designed for hiking in cold and rainy conditions.",
    dimensions: 1024,
    normalize: true,
  }),
}));

const { embedding } = JSON.parse(new TextDecoder().decode(response.body));

// Store the product with its embedding
const item = marshall({
  ProductId: "JACKET-123",
  Name: "StormShield Alpine Jacket",
  Category: "outdoor",
  Description: "Lightweight waterproof shell designed for hiking in cold and rainy conditions.",
  Price: 189,
  Available: true,
});

// Add the embedding as L(ist) of N(umber) values
item.Embedding = { L: embedding.map((n: number) => ({ N: n.toString() })) };

await dynamodb.send(new PutItemCommand({ TableName: "Products", Item: item }));
```

The embedding model produces a 1024-dimensional vector from the product's name and description. That vector now lives alongside the operational attributes in the same item.

![Image description](https://dev-to-uploads.s3.us-east-2.amazonaws.com/uploads/articles/vuseqkbxmvzom4rg175l.png)

![Image description](https://dev-to-uploads.s3.us-east-2.amazonaws.com/uploads/articles/67sz1lkvgi4i65bbuhx5.png)

## 🎯 Semantic search and structured filters

Let's go back to the original request:

> "I'm going hiking in Iceland in October. I need something lightweight, waterproof and I'd like to stay under €250."

There are really two different things happening here.

The first part is semantic:

```text
lightweight
waterproof
hiking
cold weather
```

The second part is a normal application constraint:

```text
price <= 250
available = true
```

`DynamoDB Vector Search` allows us to bring these two worlds together: the query embedding tells us which products are semantically relevant while the DynamoDB attributes tell us whether those products actually satisfy the application constraints.

This is an important distinction, as we're not replacing our normal database queries with vector search but we're adding another dimension to them.

And that's probably the way I'd think about DynamoDB Vector Search in an application.

Not:

> "Let's put a vector database next to our application."

But:

> "Let's make some of our existing application entities searchable by meaning."

## 🧠 Using an LLM to separate meaning from filters

This is a practical problem that comes up as soon as you try to build this: the user writes one sentence, but we need to split it into two different things, with the semantic part going to the embedding model and the structured part becoming a filter.

A user writes:

> "I'm looking for a warm jacket for winter hiking, under 200 euros"

We need to turn that into:

| What | Where it goes |
|------|--------------|
| `warm jacket for winter hiking` | → embedding model → vector search |
| `price <= 200` | → post-search filter on DynamoDB attribute |

But the user doesn't make that distinction. They write one sentence that mixes intent and constraints, so we need something that understands natural language well enough to tell the two apart.

**This is where a small LLM comes in.**

Before we even touch the vector index, we can send the user's query to a fast, inexpensive model like `Amazon Nova Micro` and ask it to extract two things:

1. The **semantic description**, what the user is looking for by meaning
2. The **structured filters**, price range, availability, or any other attribute constraint

```typescript
async function parseUserQuery(userQuery: string): Promise<ParsedQuery> {
  const systemPrompt = `You are a query parser for a product search engine.
Given a user's natural language query, extract:
1. The semantic/descriptive part (what the user is looking for by meaning)
2. Any structured filters (price constraints, availability)

Respond ONLY with a JSON object:
{
  "semanticQuery": "the descriptive part for semantic search",
  "maxPrice": number or null,
  "minPrice": number or null,
  "availableOnly": true or null
}`;

  const response = await bedrock.send(new InvokeModelCommand({
    modelId: "eu.amazon.nova-micro-v1:0",
    contentType: "application/json",
    accept: "application/json",
    body: JSON.stringify({
      schemaVersion: "messages-v1",
      system: [{ text: systemPrompt }],
      messages: [{ role: "user", content: [{ text: userQuery }] }],
      inferenceConfig: { maxTokens: 200, temperature: 0 },
    }),
  }));

  const body = JSON.parse(new TextDecoder().decode(response.body));
  const parsed = JSON.parse(body.output.message.content[0].text);
  return parsed;
}
```

For the query *"warm jacket for winter hiking, under 200 euros"*, Nova Micro returns:

```json
{
  "semanticQuery": "warm jacket for winter hiking",
  "maxPrice": 200,
  "minPrice": null,
  "availableOnly": null
}
```

Now we have a clean separation: the semantic query goes to the embedding model and then to `SearchVectors`, while the price constraint is applied as a post-search filter on the results.

![Image description](https://dev-to-uploads.s3.us-east-2.amazonaws.com/uploads/articles/u3eexb22c62v2qn5swp7.png)

## 🔎 Calling SearchVectors

With the semantic query extracted, we generate an embedding and call `SearchVectors`. This is the core of the vector search:

```typescript
// Generate embedding from the semantic part only
const queryEmbedding = await generateEmbedding(parsed.semanticQuery);

// SearchVectors expects a plain array of {N: "value"} objects (not wrapped in L type)
const searchVector = queryEmbedding.map((n) => ({ N: n.toString() }));

const result = await dynamodb.send(new SearchVectorsCommand({
  TableName: "Products",
  IndexName: "ProductEmbeddingIndex",
  SearchVector: searchVector,
  TopK: 20,  // fetch extra to account for post-filtering
  ProjectionExpression: "ProductId, #n, Category, Description, Price, Available",
  ExpressionAttributeNames: { "#n": "Name" },
}));
```

A few things worth noting about the `SearchVectors` API:

- **SearchVector** is a plain array of `{N: "value"}` objects, **not** wrapped in the DynamoDB `L` type. This is different from how you store the vector in a `PutItem`, where you use `{L: [{N: "0.123"}, ...]}`.
- **TopK** controls how many results come back (max 100). We ask for more than we need because we're going to filter some out in the next step.
- **ProjectionExpression** works just like in `Query` or `Scan`. You can only return attributes that are projected into the vector index.
- The results come back sorted by similarity, with the most similar item first. Each result includes the item attributes and a **Score**. For COSINE, lower is better.

## 🔧 Applying structured filters after the search

Now we combine the vector search results with the structured filters that Nova Micro extracted. Since `SearchConditionExpression` currently only supports equality operators, we apply range filters in our application code:

```typescript
// Map DynamoDB items to our application types
let products = result.SearchResults.map((r) => {
  const item = unmarshall(r.Item);
  return {
    productId: item.ProductId,
    name: item.Name,
    category: item.Category,
    description: item.Description,
    price: item.Price,
    available: item.Available,
    score: r.Score,
  };
});

// Apply the structured filters extracted by Nova Micro
if (parsed.maxPrice != null) {
  products = products.filter((p) => p.price <= parsed.maxPrice);
}
if (parsed.minPrice != null) {
  products = products.filter((p) => p.price >= parsed.minPrice);
}
if (parsed.availableOnly) {
  products = products.filter((p) => p.available);
}

// Return the top results
return products.slice(0, 5);
```

This is why we asked for `TopK: 20` instead of 5. After filtering out products that don't meet the price constraint, we still want enough results left to return.

The complete flow through the Lambda looks like this:

![Image description](https://dev-to-uploads.s3.us-east-2.amazonaws.com/uploads/articles/qx1ssuwxjix6fwgeucfj.png)

Each step has a clear responsibility: Nova Micro understands the user's language, Titan Embeddings turns meaning into a vector, DynamoDB finds the closest matches, and the application logic applies the business constraints.

![Image description](https://dev-to-uploads.s3.us-east-2.amazonaws.com/uploads/articles/9ltol0feya5tep5uws0c.png)

## 🤖 Now let's give this capability to an AI agent

Once `DynamoDB` can answer semantic questions about our application data, the next step is giving that capability to an AI agent as a **tool**.

We could create a generic tool like `search_vectors`, but I don't think that's particularly useful.

The agent doesn't need to know that we're using `DynamoDB`, it doesn't need to know about vector indexes, and it doesn't need to understand embeddings. **Those are implementation details**.

What the agent needs is a capability that makes sense in the context of the application. For our e-commerce application, that could simply be `search_products`: the agent calls it with a natural language description of what the user wants, and the tool handles everything behind the scenes, including LLM parsing, embedding generation, vector search and structured filtering.

Whether we expose this tool through **MCP** (Model Context Protocol), through Bedrock's native **tool use** in the Converse API, or through any other tool-calling mechanism doesn't really change the pattern. The key idea is the same: **the database capability becomes a tool that the agent can use**.

In our sample application, we use the **Amplify AI Kit** which provides a conversation route backed by Amazon Bedrock. We define `searchProducts` as a tool that the conversation model can invoke:

```typescript
chat: a.conversation({
  aiModel: a.ai.model("Amazon Nova Lite"),
  systemPrompt: `You are a helpful AI shopping assistant for an outdoor gear store.
When a user describes what they're looking for, use the searchProducts tool 
to find relevant products. Present the results in a friendly, conversational way.`,
  tools: [
    a.ai.dataTool({
      name: "searchProducts",
      description: "Search the product catalog using natural language.",
      query: a.ref("searchProducts"),
    }),
  ],
})
```

The architecture becomes:

![Image description](https://dev-to-uploads.s3.us-east-2.amazonaws.com/uploads/articles/fy4fbi5rg2jxvqclctsq.png)

The agent decides **when** to search and **what** to search for, the tool handles the **how**, and `DynamoDB Vector Search` is what makes the search actually understand the user's intent.

## 💬 Building a conversational shopping experience

Now let's put all of this together and see it in action.

The user opens the chat and writes:

> "I'm going hiking in Iceland in October. I need something lightweight, waterproof and I'd like to stay under €250."

The agent reads the message, decides it needs product data, and calls the `searchProducts` tool with the user's request. Behind the scenes, our Lambda does its four-step job: Nova Micro separates the semantic intent from the price constraint, Titan Embeddings generates a vector, DynamoDB `SearchVectors` finds the closest products, and the application filters out anything over €250.

The results flow back to the agent, which presents them conversationally:

![Image description](https://dev-to-uploads.s3.us-east-2.amazonaws.com/uploads/articles/uscm3k4ntey94es1dyt5.png)

![Image description](https://dev-to-uploads.s3.us-east-2.amazonaws.com/uploads/articles/sizerby45um60llgpdun.png)

**But the conversation doesn't stop there.**

The user might say:

> "I don't really like the first one. Can you find something less technical looking?"

The agent performs another search using the new context. It doesn't start from scratch, but understands the conversation history and refines its search.

![Image description](https://dev-to-uploads.s3.us-east-2.amazonaws.com/uploads/articles/o9u1idoewh7940vgrpy0.png)

And again:

> "Something similar to the second one, but cheaper."

The agent handles the conversation, the tool handles the search, and DynamoDB handles the data, each piece doing what it's good at.

## 🎤 Taking it further: a voice shopping assistant

Text chat is one way to interact with this system. But what if the user could just **talk**?

With `Amazon Nova 2 Sonic`, Amazon's speech-to-speech foundation model, we can build a voice agent that listens to the user, understands what they need, searches the product catalog using the same `search_products` tool, and responds by voice. The user never types a word.

The framework we use for this is `Strands Agents`, an open source SDK for building AI agents. Its `BidiAgent` class handles the bidirectional streaming lifecycle: audio in, audio out, tool calls in between.

Here is the complete voice agent:

```python
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from strands.experimental.bidi import BidiAgent
from strands.experimental.bidi.models import BidiNovaSonicModel
from strands import tool

# Our product search tool (same logic as the Lambda)
@tool
def search_products(query: str) -> str:
    """
    Search the product catalog using natural language.
    Returns matching products with names, prices and descriptions.

    Args:
        query: Natural language description of what the user wants.
    """
    # 1. Parse query with Nova Micro (semantic vs filters)
    parsed = parse_user_query(query)
    # 2. Generate embedding with Titan
    embedding = generate_embedding(parsed["semanticQuery"])
    # 3. SearchVectors in DynamoDB
    results = dynamodb.search_vectors(...)
    # 4. Apply price filters
    filtered = apply_filters(results, parsed)
    return format_results(filtered)

# Configure Nova 2 Sonic
sonic_model = BidiNovaSonicModel(
    model_id="amazon.nova-2-sonic-v1:0",
    provider_config={
        "audio": {
            "voice": "tiffany",
            "input_rate": 16000,
            "output_rate": 16000,
        },
    },
)

app = FastAPI()

@app.websocket("/ws")
async def voice_chat(websocket: WebSocket):
    agent = BidiAgent(
        model=sonic_model,
        tools=[search_products],
        system_prompt="You are a helpful voice assistant for an outdoor gear store.",
    )

    await websocket.accept()
    await agent.run(
        inputs=[websocket.receive_json],
        outputs=[websocket.send_json],
    )
```

That's the entire server. A few things worth noting:

- The `@tool` decorator from Strands turns a regular Python function into a tool that the voice model can invoke. The same `search_products` function we built before, with the same four-step pipeline, now works inside a voice conversation.
- `BidiAgent` manages the full bidirectional stream: it receives PCM audio from the browser, sends it to Nova 2 Sonic, handles tool calls when the model decides to search, and streams the voice response back.
- The WebSocket integration is remarkably simple. `websocket.receive_json` and `websocket.send_json` are passed directly as the agent's input and output channels. Strands handles the protocol.

The user says *"I need something waterproof for hiking, under 200 euros"* and the agent responds by voice with product recommendations. The entire flow, from speech recognition to product search to voice response, happens in a single streaming connection.

![Image description](https://dev-to-uploads.s3.us-east-2.amazonaws.com/uploads/articles/vgqaw02d00st97s629ih.png)

Another interesting aspect is that, by simply using a multilingual model like `Amazon Nova Sonic 2`, your assistant becomes multilingual out of the box. You don't need to change a single line of code.

![Image description](https://dev-to-uploads.s3.us-east-2.amazonaws.com/uploads/articles/dx5e3mf8v9ons4pdc308.png)

For local development, the agent runs as a simple Python server on `localhost:8080`. On the frontend, a React component captures microphone audio via an `AudioWorklet`, streams it over WebSocket, and plays back the agent's audio response.

For production, this same agent can be deployed on **Amazon Bedrock AgentCore Runtime**, which provides managed WebSocket infrastructure with authentication, auto-scaling, and session management. The agent code stays the same, while AgentCore handles the operational concerns: IAM-based authentication via SigV4-signed WebSocket URLs, isolated microVM execution, and automatic scaling based on demand.

## 🏪 What about a marketplace?

Let's change the application without changing the architecture.

Instead of products managed by a store, imagine a marketplace where users create listings.

A listing could look like this:

```json
{
  "listingId": "LISTING-9281",
  "title": "Nike Air Max 90",
  "description": "White and grey sneakers, worn a few times, size 42.",
  "category": "sneakers",
  "size": 42,
  "price": 75,
  "country": "IT",
  "embedding": [...]
}
```

A buyer would say:

> "I'm looking for white sneakers for everyday use, size 42, under €100."

The agent calls a `search_listings` tool and the semantic part of the query could be:

```text
white casual sneakers suitable for everyday use
```

while `DynamoDB` filters can handle:

```text
size = 42
price <= 100
country = IT
```

The interesting part here is that we're searching user-generated content. One seller might write:

> "White Nike sneakers, barely used."

Another might write:

> "Clean white trainers, perfect for daily outfits."

Another might simply write:

> "Nike Air Max 90, white and grey, size 42."

**The wording is different, but the intent is the same, and that's exactly where semantic search makes the application feel more natural.** And again, the vector search is happening directly against the application data stored in `DynamoDB`.

## 🧩 The pattern is bigger than e-commerce

At this point, I think the interesting part isn't really the store or the marketplace. They're just convenient examples for this digression. The actual pattern is much more general: it covers any app where we have an application entity that already lives in `DynamoDB`.

We can generate an embedding that represents the parts of that entity users may want to search semantically, and store it alongside the entity.

`DynamoDB Vector Search` lets us retrieve those entities based on semantic similarity while still working with their normal attributes.

Then we expose that capability to an AI agent as a tool, whether through MCP, Bedrock tool use, or any other mechanism.

That entity might be a product, a marketplace listing, a hotel, a job, an event, a course or anything else that users need to discover based on meaning. The important thing is that the vector belongs to the application entity.

## ✨ What I like about this architecture

There is a subtle but important difference between this and the way we usually approach RAG.

With a typical RAG architecture, we're taking documents, splitting them into chunks, generating embeddings and putting those chunks into a retrieval system. The thing we're retrieving is knowledge.

**Here, we're retrieving application state**.

## 🤔 So when would I use DynamoDB Vector Search?

I don't think the answer should be "whenever I need vectors." There are plenty of workloads where a dedicated search or vector database is a better fit.

If I'm building a huge document retrieval platform, for example, I'm probably going to evaluate solutions specifically designed around that problem.

The use case I find particularly compelling is when the data already lives in `DynamoDB` and the application needs to find those entities based on their semantic meaning. In these cases, the vector isn't really a separate piece of knowledge but rather another way of looking at the application data.

### 🎯 When to Use DynamoDB Vector Search vs. Dedicated Vector Databases

| Scenario / Requirement | Use DynamoDB Vector Search | Use a Dedicated Vector DB |
| :--- | :--- | :--- |
| **Single Source of Truth** | Your primary application data **already lives in DynamoDB**, and vectors represent another semantic dimension of the same entity. | Your source data consists of raw unstructured documents, PDFs, or logs stored primarily for search/RAG pipelines. |
| **Architecture & Sync** | You want to avoid complex ETL pipelines and maintain data sync seamlessly via **DynamoDB Streams** without extra orchestration. | You are willing to manage a separate ETL/sync pipeline between your primary DB and the Vector DB to leverage advanced vector features. |
| **Filtering & Querying** | Simple vector searches or queries **combined with DynamoDB Partition/Sort Keys** (e.g., *find similar products belonging to User X*). | Complex dynamic metadata filtering, multi-faceted aggregations, or heavy hybrid search algorithms (BM25 + Dense Vectors). |
| **Vector Scale** | Hundreds of thousands to tens of millions of vectors tied directly to application domain entities. | Billions of vectors at massive global scale for dedicated enterprise-wide document retrieval platforms. |
| **Latency Requirements** | Acceptable query latency in the **tens of milliseconds** range | Strict **sub-10ms** latency requirements for high-frequency, real-time nearest-neighbor (HNSW) search. |
| **Cost & Operational Overhead** | Great for serverless-first architectures with variable or moderate traffic, leveraging pay-per-use components. | More cost-effective at sustained massive scale with dedicated instance-based indexing and fine-tuned memory usage. |

## 🛠️ Your database is an AI tool

This is what I find most interesting about the whole thing.

We usually think of a database as something the application talks to; with AI agents, we should start to see it differently.

We can take the database that already contains our application entities, make those entities searchable by meaning, and expose that capability as a tool that an agent can use, whether through MCP, Bedrock tool use, or any tool-calling mechanism that fits the application.

The result isn't really a new "AI database" because it's still our application database: **The vector isn't the destination. It's a new way for an AI agent to discover the data your application already owns.**

Your database is an AI tool.

## 🙋 Who am I
I'm [D. De Sio](https://www.linkedin.com/in/desiodavide) and I work as a Head of Software Engineering in [Eleva](https://eleva.it/).
As of June 2026, I’m an [AWS Certified Solution Architect Professional](https://www.credly.com/badges/9929fdf2-7a3d-4013-9de6-57c80e4920b9/public_url) and [AWS Certified DevOps Engineer Professional](https://www.credly.com/badges/8c5a1487-191b-429e-8c2d-7cee43bf316b/public_url), but also a [User Group Leader (in Pavia)](https://www.linkedin.com/company/aws-user-group-pavia/), an **AWS Community Builder** and, last but not least, a #serverless enthusiast.

![Image description](https://dev-to-uploads.s3.us-east-2.amazonaws.com/uploads/articles/9vr37xpyf1qmralxmdfi.png)

## AWS Community Day Italy
Did you know that the Call for Papers for [AWS Community Day Italy](https://www.awscommunityday.it/) is still open?

We’d love to hear what you’ve been working on, what you’ve learned, and what you’d like to share with the AWS community.

**Have a talk in mind? This is your chance!**

👉 Check out the Call for Papers and submit your proposal [here](https://conference-hall.io/aws-community-day-italy-2026).