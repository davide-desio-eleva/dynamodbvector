"""
Voice agent server using Strands BidiAgent with Nova Sonic.
Exposes a WebSocket endpoint that the React frontend connects to
for real-time voice conversations with product search capability.
"""

import os
import json
import uuid
import base64
import boto3
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from strands.experimental.bidi import BidiAgent
from strands.experimental.bidi.models.bedrock import BedrockNovaSonicModel
from strands.experimental.bidi.tools import stop_conversation
from strands import tool
from bedrock_agentcore.memory.integrations.strands.config import (
    AgentCoreMemoryConfig,
)
from bedrock_agentcore.memory.integrations.strands.session_manager import (
    AgentCoreMemorySessionManager,
)
from bedrock_agentcore.memory.client import MemoryClient

# ── Configuration ────────────────────────────────────────────────────────
BEDROCK_REGION = os.getenv("BEDROCK_REGION", "eu-north-1")
TABLE_NAME = os.getenv("TABLE_NAME", "")
TABLE_REGION = os.getenv("TABLE_REGION", "eu-west-1")
EMBEDDING_MODEL_ID = os.getenv("EMBEDDING_MODEL_ID", "amazon.titan-embed-text-v2:0")
LLM_MODEL_ID = os.getenv("LLM_MODEL_ID", "eu.amazon.nova-micro-v1:0")
MEMORY_ID = os.getenv("MEMORY_ID", "")
MEMORY_REGION = os.getenv("MEMORY_REGION", "eu-west-1")

# ── AWS Clients ──────────────────────────────────────────────────────────
dynamodb_client = boto3.client("dynamodb", region_name=TABLE_REGION)
bedrock_client = boto3.client("bedrock-runtime", region_name=TABLE_REGION)
memory_client = MemoryClient(region_name=MEMORY_REGION) if MEMORY_ID else None


def generate_embedding(text: str) -> list[float]:
    """Generate a 1024-dim embedding using Titan Text Embeddings V2."""
    response = bedrock_client.invoke_model(
        modelId=EMBEDDING_MODEL_ID,
        contentType="application/json",
        accept="application/json",
        body=json.dumps({
            "inputText": text,
            "dimensions": 1024,
            "normalize": True,
        }),
    )
    body = json.loads(response["body"].read())
    return body["embedding"]


def parse_user_query(user_query: str) -> dict:
    """Use Nova Micro to separate semantic query from structured filters."""
    system_prompt = """You are a query parser for a product search engine.
Given a user's natural language query, extract:
1. The semantic/descriptive part (what the user is looking for by meaning)
2. Any structured filters (price constraints, availability)

Respond ONLY with a JSON object:
{
  "semanticQuery": "the descriptive part for semantic search",
  "maxPrice": number or null,
  "minPrice": number or null,
  "availableOnly": true or null
}"""

    response = bedrock_client.invoke_model(
        modelId=LLM_MODEL_ID,
        contentType="application/json",
        accept="application/json",
        body=json.dumps({
            "schemaVersion": "messages-v1",
            "system": [{"text": system_prompt}],
            "messages": [{"role": "user", "content": [{"text": user_query}]}],
            "inferenceConfig": {"maxTokens": 200, "temperature": 0},
        }),
    )
    body = json.loads(response["body"].read())
    text = body["output"]["message"]["content"][0]["text"]

    import re
    match = re.search(r"\{[\s\S]*\}", text)
    if match:
        return json.loads(match.group())
    return {"semanticQuery": user_query}


# ── The search_products tool (available to the voice agent) ──────────────
@tool
def search_products(query: str) -> str:
    """
    Search the product catalog using natural language.
    The query should describe what the user is looking for,
    including any price constraints mentioned.
    Returns a list of matching products with names, prices and descriptions.

    Args:
        query: Natural language description of what the user wants.
    """
    if not TABLE_NAME:
        return "Error: TABLE_NAME not configured. Set it as an environment variable."

    # Step 1: Parse the query
    parsed = parse_user_query(query)
    semantic_query = parsed.get("semanticQuery", query)
    max_price = parsed.get("maxPrice")
    min_price = parsed.get("minPrice")

    # Step 2: Generate embedding
    embedding = generate_embedding(semantic_query)

    # Step 3: SearchVectors
    search_vector = [{"N": str(n)} for n in embedding]

    params = {
        "TableName": TABLE_NAME,
        "IndexName": "ProductEmbeddingIndex",
        "SearchVector": search_vector,
        "TopK": 20,
        "ProjectionExpression": "ProductId, #n, Category, Description, Price, Available",
        "ExpressionAttributeNames": {"#n": "Name"},
    }

    result = dynamodb_client.search_vectors(**params)

    # Step 4: Map and filter results
    products = []
    for r in result.get("SearchResults", []):
        item = r["Item"]
        price = float(item["Price"]["N"])
        available = item["Available"]["BOOL"]

        if max_price is not None and price > max_price:
            continue
        if min_price is not None and price < min_price:
            continue

        products.append({
            "name": item["Name"]["S"],
            "category": item["Category"]["S"],
            "description": item["Description"]["S"],
            "price": price,
            "available": available,
        })

    products = products[:6]

    if not products:
        return "No products found matching your criteria."

    # Format results for the voice agent
    lines = [f"I found {len(products)} products:\n"]
    for i, p in enumerate(products, 1):
        status = "in stock" if p["available"] else "out of stock"
        lines.append(
            f"{i}. {p['name']} - €{p['price']:.0f} ({status}). "
            f"{p['description']}"
        )
    return "\n".join(lines)


# ── Nova Sonic model ─────────────────────────────────────────────────────
sonic_model = BedrockNovaSonicModel(
    model_id="amazon.nova-2-sonic-v1:0",
    region=BEDROCK_REGION,
    voice="tiffany",
    audio={
        "input": {"sample_rate": 16000},
        "output": {"sample_rate": 16000},
    },
)

# ── FastAPI app ──────────────────────────────────────────────────────────
app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

SYSTEM_PROMPT = """You are a friendly AI shopping assistant for an outdoor gear store.
You help users find products by understanding what they need.
When a user describes what they're looking for, use the search_products tool to find relevant products.
Present results naturally in a conversational voice. Mention the product name, price, and a brief reason why it matches.
If the user mentions a price constraint, include it in your search query.
Always search before answering product questions. Do not make up products.

You may be given context about the user's known preferences and facts from previous
conversations (across voice and chat). Use them to personalize your suggestions and to
avoid asking again for things you already know. When the user shares a new preference
(a budget, a style, a use case, a size), acknowledge it naturally so it can be remembered.

Keep your responses concise and natural for voice conversation."""


def _decode_jwt_sub(token: str) -> str | None:
    """Best-effort extraction of the `sub` claim from a JWT (no verification).
    The runtime's JWT authorizer already validated the token before the request
    reached the container; here we only read the identity to key the memory."""
    try:
        payload = token.split(".")[1]
        payload += "=" * (-len(payload) % 4)  # pad base64url
        claims = json.loads(base64.urlsafe_b64decode(payload))
        return claims.get("sub")
    except Exception:
        return None


def resolve_actor_id(websocket: WebSocket) -> str:
    """Determine the memory actorId (the Cognito `sub`) for this connection.

    AgentCore forwards the caller's bearer token and custom headers to the
    container. We try, in order:
      1. the `sub` from the Authorization bearer JWT,
      2. an explicit custom header the client set on the connection,
    and fall back to an anonymous id if neither is present.
    """
    headers = websocket.headers
    auth = headers.get("authorization")
    if auth:
        token = auth[7:] if auth.lower().startswith("bearer ") else auth
        sub = _decode_jwt_sub(token)
        if sub:
            return sub
    custom = headers.get("x-amzn-bedrock-agentcore-runtime-custom-actorid")
    if custom:
        return custom
    return "anonymous"


def retrieve_memories(actor_id: str) -> list[str]:
    """Fetch this user's long-term preferences and facts from AgentCore Memory.

    The native session manager persists events for us, but it deliberately skips
    long-term retrieval for BidiAgent (Nova Sonic), so we read the records here
    and inject them into the system prompt ourselves. We key the lookup by the
    Cognito sub, the same actorId the text chat agent uses, so a preference
    learned in either channel is available in the other.
    """
    if not memory_client or not MEMORY_ID:
        return []

    namespaces = [f"/preferences/{actor_id}/", f"/facts/{actor_id}/"]
    query = "user preferences, interests and facts"
    context: list[str] = []
    for namespace in namespaces:
        try:
            records = memory_client.retrieve_memories(
                memory_id=MEMORY_ID,
                namespace_path=namespace,
                query=query,
                top_k=5,
            )
            for record in records:
                content = record.get("content", {}) if isinstance(record, dict) else {}
                text = (content.get("text") or "").strip() if isinstance(content, dict) else ""
                if text:
                    context.append(text)
        except Exception as e:
            print(f"Memory retrieval failed for {namespace}: {e}")
    return context


def build_system_prompt(actor_id: str) -> str:
    """Compose the voice agent's system prompt, injecting remembered context."""
    context = retrieve_memories(actor_id)
    if not context:
        return SYSTEM_PROMPT
    remembered = "\n".join(f"- {item}" for item in context)
    print(f"Injected {len(context)} memory items for actor {actor_id[:8]}...")
    return (
        f"{SYSTEM_PROMPT}\n\n"
        "Here is what you remember about this customer from previous "
        "conversations, across both voice and chat. Use it to personalize your "
        "suggestions, and confirm before assuming it still applies:\n"
        f"{remembered}"
    )


@app.get("/ping")
async def ping():
    return {"status": "ok"}


@app.websocket("/ws")
async def voice_chat(websocket: WebSocket) -> None:
    """WebSocket endpoint for bidirectional voice streaming."""
    actor_id = resolve_actor_id(websocket)
    session_id = str(uuid.uuid4())
    print(f"WebSocket connection for actor {actor_id[:8]}... session {session_id[:8]}...")

    session_manager = None
    if MEMORY_ID:
        # The session manager persists this conversation's turns to AgentCore
        # Memory (short-term events, later distilled into long-term preferences
        # and facts). Note: it deliberately skips long-term *retrieval* for
        # BidiAgent, so we inject remembered context into the system prompt
        # ourselves (see build_system_prompt).
        memory_config = AgentCoreMemoryConfig(
            memory_id=MEMORY_ID,
            session_id=session_id,
            actor_id=actor_id,
        )
        session_manager = AgentCoreMemorySessionManager(
            agentcore_memory_config=memory_config,
            region_name=MEMORY_REGION,
        )

    voice_agent = BidiAgent(
        model=sonic_model,
        tools=[search_products, stop_conversation],
        system_prompt=build_system_prompt(actor_id),
        session_manager=session_manager,
    )

    try:
        await websocket.accept()
        print("WebSocket connection accepted")

        await voice_agent.run(
            inputs=[websocket.receive_json],
            outputs=[websocket.send_json],
        )
    except WebSocketDisconnect:
        print("Client disconnected")
    except Exception as e:
        print(f"Error in voice chat: {e}")
        import traceback
        traceback.print_exc()
    finally:
        try:
            await websocket.close()
            await voice_agent.stop()
        except Exception:
            pass


if __name__ == "__main__":
    import uvicorn

    # AgentCore Runtime runs the container and expects the server on 0.0.0.0:8080.
    # Locally we bind to 127.0.0.1 unless CONTAINER_ENV is set.
    host = "0.0.0.0" if os.getenv("CONTAINER_ENV") else "127.0.0.1"

    print("Starting voice agent server on port 8080...")
    print(f"Binding to: {host}")
    print(f"Bedrock Region: {BEDROCK_REGION}")
    print(f"Table: {TABLE_NAME} (region: {TABLE_REGION})")
    uvicorn.run(app, host=host, port=8080)
