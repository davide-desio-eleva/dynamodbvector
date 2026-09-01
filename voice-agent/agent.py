"""
Voice agent server using Strands BidiAgent with Nova Sonic.
Exposes a WebSocket endpoint that the React frontend connects to
for real-time voice conversations with product search capability.
"""

import os
import json
import boto3
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from strands.experimental.bidi import BidiAgent
from strands.experimental.bidi.models import BidiNovaSonicModel
from strands.experimental.bidi.tools import stop_conversation
from strands import tool

# ── Configuration ────────────────────────────────────────────────────────
BEDROCK_REGION = os.getenv("BEDROCK_REGION", "eu-north-1")
TABLE_NAME = os.getenv("TABLE_NAME", "")
TABLE_REGION = os.getenv("TABLE_REGION", "eu-west-1")
EMBEDDING_MODEL_ID = os.getenv("EMBEDDING_MODEL_ID", "amazon.titan-embed-text-v2:0")
LLM_MODEL_ID = os.getenv("LLM_MODEL_ID", "eu.amazon.nova-micro-v1:0")

# ── AWS Clients ──────────────────────────────────────────────────────────
dynamodb_client = boto3.client("dynamodb", region_name=TABLE_REGION)
bedrock_client = boto3.client("bedrock-runtime", region_name=TABLE_REGION)


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
sonic_model = BidiNovaSonicModel(
    model_id="amazon.nova-2-sonic-v1:0",
    provider_config={
        "audio": {
            "voice": "tiffany",
            "input_rate": 16000,
            "output_rate": 16000,
            "channels": 1,
            "format": "pcm",
        },
        "inference": {},
    },
    client_config={
        "region": BEDROCK_REGION,
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
Keep your responses concise and natural for voice conversation."""


@app.get("/ping")
async def ping():
    return {"status": "ok"}


@app.websocket("/ws")
async def voice_chat(websocket: WebSocket) -> None:
    """WebSocket endpoint for bidirectional voice streaming."""
    voice_agent = BidiAgent(
        model=sonic_model,
        tools=[search_products, stop_conversation],
        system_prompt=SYSTEM_PROMPT,
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

    print(f"Starting voice agent server on port 8080...")
    print(f"Bedrock Region: {BEDROCK_REGION}")
    print(f"Table: {TABLE_NAME} (region: {TABLE_REGION})")
    uvicorn.run(app, host="127.0.0.1", port=8080)
