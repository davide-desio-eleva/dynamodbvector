# 🏃 TL;DR

In the [first article](https://dev.to/aws-builders/your-database-is-an-ai-tool-semantic-search-with-amazon-dynamodb-vector-search-46ff) I built semantic product search on `Amazon DynamoDB` Vector Search and gave that capability to an AI agent as a tool. In the [second one](https://dev.to/aws-builders/deploying-a-real-time-voice-agent-with-agentcore-runtime-and-amplify-gen-2-45bl) I deployed the voice agent to `Amazon Bedrock AgentCore Runtime`, inside the same `Amplify Gen 2` backend.

So now I have two agents that do the same job, help a user shop, through two different channels: a **text chat** (Amplify AI Kit) and a **voice agent** (Strands `BidiAgent` + `Amazon Nova Sonic`).

They work. But they are two strangers. Tell the voice agent you are into ultralight camping gear, then open the chat and ask for a recommendation: it has no idea who you are. Each conversation starts from zero.

**This article is about fixing that: giving both agents a shared memory so a preference learned in one channel shows up in the other.** That is what turns "a few agents" into an omnichannel experience.

I'll use **Amazon Bedrock AgentCore Memory**, and the key idea is deciding what the memory is keyed to. Let me walk through it.

{% github https://github.com/davide-desio-eleva/dynamodbvector %}

## 🧠 Two kinds of memory

Before wiring anything, it helps to separate two things that both get called "memory".

**Short-term memory** is the current conversation. The turns you and the agent just exchanged, so it can follow "make it cheaper" without asking cheaper than what. It lives and dies with the session.

**Long-term memory** is what survives across sessions. Not the raw transcript, but distilled knowledge: "this customer likes ultralight gear", "their budget is around 150 euros", "they camp in winter". This is the part that makes an omnichannel experience possible, because it outlives any single conversation and any single channel.

`Amazon Bedrock AgentCore Memory` gives me both. I write raw events (short-term), and it runs extraction strategies in the background that distill those events into long-term records. I get to pick which strategies run:

- **User Preference** extracts subjective likes and dislikes (`prefers ultralight gear`, `budget around 150 euros`).
- **Semantic** extracts objective facts (`bought a DayHike 25L Pack`, `camps in winter`).

There is also a Summarization strategy, but for a shopping assistant the preferences and facts are what matter, so I'll use those two.

## 🔑 The one decision that matters: what is memory keyed to?

Here is the insight that makes or breaks the whole thing.

AgentCore Memory organizes records under an **`actorId`** and a **`sessionId`**. The natural temptation is to let each agent use its own runtime session as the identity. If you do that, the voice agent remembers voice sessions and the chat agent remembers chat sessions, and they never meet. You would have two separate memories that happen to use the same service.

**For omnichannel, the memory has to be keyed to the *user*, not to the runtime session or the channel.**

My app already has a stable per-user identifier: the `Amazon Cognito` **`sub`**. The same user signs into the chat and the voice agent, so if both agents use the Cognito `sub` as the `actorId`, they read and write the same records. A preference the voice agent stored under `sub=a2751...` is exactly what the chat agent retrieves under `sub=a2751...`.

So the design is one memory store, two agents, keyed by the Cognito `sub`:

```text
              Amazon Bedrock AgentCore Memory
                   (actorId = Cognito sub)
        /preferences/{actorId}/     /facts/{actorId}/
                  ▲   ▲                  ▲   ▲
        write/read│   │read/write        │   │
                  │   │                  │   │
        ┌─────────┘   └────────┐  ┌──────┘   └───────┐
   Text chat agent        Voice agent (Nova Sonic)
   (Amplify AI Kit)       (Strands BidiAgent)
```

## 🏗️ Step 1: create the memory in the Amplify backend

Because `Amplify Gen 2` is `CDK` under the hood, the memory store is just another construct in `backend.ts`, next to the data, auth, and the voice runtime from the previous article. I use the L1 `CfnMemory`: for a service this new I want what I write to map one-to-one onto the `CloudFormation` resource, with no abstraction deciding things for me.

```typescript
import { CfnMemory } from "aws-cdk-lib/aws-bedrockagentcore";

const agentMemory = new CfnMemory(voiceStack, "ShoppingAgentMemory", {
  name: "shoppingAgentMemory",
  // Raw short-term events are kept for 30 days before expiring.
  eventExpiryDuration: 30,
  memoryExecutionRoleArn: memoryExecutionRole.roleArn,
  memoryStrategies: [
    {
      userPreferenceMemoryStrategy: {
        name: "PreferenceLearner",
        namespaces: ["/preferences/{actorId}/"],
      },
    },
    {
      semanticMemoryStrategy: {
        name: "FactExtractor",
        namespaces: ["/facts/{actorId}/"],
      },
    },
  ],
});

const memoryId = agentMemory.attrMemoryId;
```

Two things worth calling out.

The `namespaces` use a `{actorId}` template. AgentCore substitutes the real `actorId` at write and read time, so `/preferences/{actorId}/` becomes `/preferences/a2751.../` for that user. This is what physically separates one user's memories from another's, using the same key both agents share.

The `memoryExecutionRoleArn` matters because long-term extraction runs `Amazon Bedrock` models **on your behalf**. The built-in strategies read your raw events and call a model to distill them, so the memory needs a role allowed to invoke Bedrock:

```typescript
const memoryExecutionRole = new iam.Role(voiceStack, "AgentMemoryRole", {
  assumedBy: new iam.ServicePrincipal("bedrock-agentcore.amazonaws.com", {
    conditions: { StringEquals: { "aws:SourceAccount": account } },
  }),
});
memoryExecutionRole.addToPolicy(new iam.PolicyStatement({
  actions: ["bedrock:InvokeModel"],
  resources: ["arn:aws:bedrock:*::foundation-model/*"],
}));
```

Then both the voice runtime role and the chat handler role get read/write access to the memory (`CreateEvent`, `RetrieveMemoryRecords`, `ListMemoryRecords`, and friends) on `agentMemory.attrMemoryArn`, and both get `MEMORY_ID` as an environment variable. Same store, same permissions, two consumers.

## 🎙️ Step 2: the voice agent

The voice agent is a Strands `BidiAgent`. The first job is to make sure it keys memory to the Cognito `sub`, not to the runtime session.

The frontend already authenticates the WebSocket to AgentCore with the user's Cognito token (that was the whole point of the JWT authorizer in the previous article). The token *is* a JWT, and the `sub` is right there inside it. So I resolve the `actorId` from the connection:

```python
def resolve_actor_id(websocket: WebSocket) -> str:
    """The memory actorId is the Cognito `sub`, shared with the chat agent."""
    headers = websocket.headers
    auth = headers.get("authorization")
    if auth:
        token = auth[7:] if auth.lower().startswith("bearer ") else auth
        sub = _decode_jwt_sub(token)  # base64url-decode the JWT payload, read `sub`
        if sub:
            return sub
    custom = headers.get("x-amzn-bedrock-agentcore-runtime-custom-actorid")
    if custom:
        return custom
    return "anonymous"
```

Now, a browser can't set arbitrary headers on a WebSocket handshake, and AgentCore only forwards headers to your container if they are on an **allowlist**. So I let the frontend pass the `sub` as a custom runtime header via a query parameter, and I allowlist it on the runtime:

```typescript
// backend.ts — on the CfnRuntime
requestHeaderConfiguration: {
  requestHeaderAllowlist: ["X-Amzn-Bedrock-AgentCore-Runtime-Custom-actorId"],
},
```

```typescript
// frontend — the Cognito sub, passed as a custom runtime header
const actorId = session.tokens?.idToken?.payload?.sub;
url += `&X-Amzn-Bedrock-AgentCore-Runtime-Custom-actorId=${encodeURIComponent(actorId)}`;
```

Values sent as `X-Amzn-Bedrock-AgentCore-Runtime-Custom-*` are delivered to the container as headers of the same name, and `resolve_actor_id` reads it. Now the voice agent and the chat agent agree on who the user is.

### Writing memory: the native session manager

For persistence, Strands and `bedrock-agentcore` offer a native integration: a session manager that transparently writes every turn to AgentCore Memory. I hand it the memory id, the session id, and, crucially, the shared `actorId`:

```python
from bedrock_agentcore.memory.integrations.strands.config import AgentCoreMemoryConfig
from bedrock_agentcore.memory.integrations.strands.session_manager import (
    AgentCoreMemorySessionManager,
)

memory_config = AgentCoreMemoryConfig(
    memory_id=MEMORY_ID,
    session_id=session_id,      # unique per conversation
    actor_id=actor_id,          # the Cognito sub — shared across channels
)
session_manager = AgentCoreMemorySessionManager(
    agentcore_memory_config=memory_config,
    region_name=MEMORY_REGION,
)

voice_agent = BidiAgent(
    model=sonic_model,
    tools=[search_products, stop_conversation],
    system_prompt=build_system_prompt(actor_id),   # more on this in a second
    session_manager=session_manager,
)
```

With the session manager attached, every turn of the conversation gets written to the memory store, and the background strategies distill preferences and facts from those turns. Writing is fully handled for me.

### Reading memory: do it yourself

Reading back is where it gets interesting, and where the two agents end up looking different.

The native session manager's automatic retrieval applies to the standard `Agent`, not to the streaming `BidiAgent` that Nova Sonic uses. For a real-time voice agent, retrieval is not wired into the loop for you. So I retrieve the long-term records myself, at the start of the session, and inject them into the system prompt:

```python
def retrieve_memories(actor_id: str) -> list[str]:
    """Fetch this user's long-term preferences and facts, keyed by Cognito sub."""
    namespaces = [f"/preferences/{actor_id}/", f"/facts/{actor_id}/"]
    context = []
    for namespace in namespaces:
        records = memory_client.retrieve_memories(
            memory_id=MEMORY_ID,
            namespace_path=namespace,
            query="user preferences, interests and facts",
            top_k=5,
        )
        for record in records:
            text = record.get("content", {}).get("text", "").strip()
            if text:
                context.append(text)
    return context


def build_system_prompt(actor_id: str) -> str:
    context = retrieve_memories(actor_id)
    if not context:
        return SYSTEM_PROMPT
    remembered = "\n".join(f"- {item}" for item in context)
    return (
        f"{SYSTEM_PROMPT}\n\n"
        "Here is what you remember about this customer from previous "
        "conversations, across both voice and chat. Use it to personalize your "
        "suggestions, and confirm before assuming it still applies:\n"
        f"{remembered}"
    )
```

So on the voice side: **the session manager writes, and I read.** The write is native, the read is manual.

## 💬 Step 3: the text chat agent

The chat agent runs on the Amplify AI Kit, through a custom conversation handler. There is no magic session manager here either, so the pattern is symmetric with the voice agent's read path: I do the retrieve-and-inject myself, plus I persist the turn.

The AI Kit passes the user's Cognito token on the conversation event headers, so I get the same `sub` the voice agent uses:

```typescript
function resolveActorId(event: ConversationTurnEvent): string | undefined {
  const auth = event.request.headers["authorization"];
  return decodeJwtSub(auth); // same base64url-decode → `sub`
}
```

Then the handler wraps the default AI Kit handler. Before the model runs, it retrieves the same namespaces and prepends what it finds to the system prompt. After, it writes the user's turn so the strategies can extract from it:

```typescript
export const handler = async (event: ConversationTurnEvent) => {
  const actorId = resolveActorId(event);

  if (memoryClient && MEMORY_ID && actorId) {
    const userText = await getLatestUserText(event);

    const [preferences, facts] = await Promise.all([
      retrieveMemory(actorId, "/preferences", userText),
      retrieveMemory(actorId, "/facts", userText),
    ]);

    const preamble = buildMemoryPreamble(preferences, facts);
    if (preamble) {
      event.modelConfiguration.systemPrompt =
        `${preamble}\n\n${event.modelConfiguration.systemPrompt}`;
    }

    if (userText) {
      await persistUserTurn(actorId, event.conversationId, userText);
    }
  }

  return handleConversationTurnEvent(event);
};
```

Same store, same `actorId`, same namespaces. The only difference from the voice agent is that here I also write manually (`persistUserTurn` calls `CreateEvent`), because there is no session manager doing it for me.

## 🔀 Two integration styles, one memory

This is the part I find genuinely interesting. The two agents talk to the *same* memory but integrate with it differently, and that is not a mistake, it's the reality of working across two runtimes:

| | Voice agent (Strands BidiAgent) | Chat agent (Amplify AI Kit) |
| --- | --- | --- |
| **Write** | Native session manager | Manual `CreateEvent` |
| **Read** | Manual retrieve + inject into system prompt | Manual retrieve + inject into system prompt |
| **Identity** | Cognito `sub` from JWT / custom header | Cognito `sub` from JWT |

The takeaway: **omnichannel memory is not about a single SDK that does everything for you. It's about agreeing on the key (the user identity) and the namespaces.** Once both agents agree that memory is keyed to the Cognito `sub` and lives under `/preferences/{actorId}/` and `/facts/{actorId}/`, the plumbing on each side can differ. The memory is the contract; the integration is per-runtime.

## 🛣️ A road I deliberately didn't take

There was another perfectly valid way to do this, and it's worth naming.

Instead of wiring each agent to AgentCore Memory through its own runtime integration, I could have built a **single "memory" tool**, a small function that reads and writes AgentCore Memory, and handed that same tool to every agent, exactly like `searchProducts` is shared today. Every agent would then remember and recall by calling the tool, the integration would be identical everywhere, and a third or fourth channel would just get the same tool. That approach is clean, uniform, and it's probably what I'd reach for if I had five channels instead of two.

I chose the other path on purpose: I wanted to explore the **native integration options** each runtime offers, the Strands session manager on the voice side, and the Amplify AI Kit conversation handler on the chat side, and see how memory fits into each one's grain rather than bolting a uniform tool on top. That's also what surfaced the interesting asymmetry above (native write, manual read for `BidiAgent`), which the shared-tool approach would have hidden.

But the difference between the two isn't just uniformity, it's **who decides when memory is used**, and that's the part I find most important.

With a memory **tool**, recall is *agentic*: the memory is one more tool in the agent's belt, and the LLM decides, turn by turn, whether to call it. That's flexible (the agent can choose to look something up only when it seems relevant) but it's also non-deterministic. The model might not call the tool when you'd want it to, so the user says "give me options" and the agent, having decided it didn't need memory this turn, answers as if it knows nothing about them. You're trusting the model's judgment about when to remember.

With the **native** integration I used here, recall is *deterministic*. I retrieve the user's preferences and inject them into the system prompt at the start of every conversation, unconditionally. The model doesn't get a vote on whether to be aware of them; the context is simply always there. For a shopping assistant that should feel like it *knows* the returning customer, "always aware" is the behavior I want, not "aware if the model felt like calling a tool".

So the trade-off is: a memory tool gives the LLM control and flexibility over recall; native injection gives *you* control and guarantees the context is present. Neither is universally right. Agentic recall shines when memory is large and lookups should be selective; deterministic injection shines when a small, high-value profile should shape every single response.

So read this article as one of two good options. If you want maximum uniformity across many agents and you're comfortable letting the model decide when to recall, a shared memory tool is a great choice. If you want the context guaranteed on every turn and you want to understand how memory plugs into Strands and Amplify Gen 2 natively, this is that exploration. Either way, the design principle that matters, keying memory to the user, is the same.

## ✅ Does it actually cross channels?

The test that matters is the bidirectional one.

**Chat, then voice.** In the text chat I say I'm shopping for camping and I pick a DayHike 25L Pack. A minute later (long-term extraction is asynchronous, it takes a moment), I open the voice agent and ask, in Italian, what it recommends for me. It brings up camping and the pack, without me repeating anything. It read what the chat agent wrote.

**Voice, then chat.** The reverse works the same way. A preference spoken to the voice agent surfaces in the next chat turn.

One thing to keep in mind when you try this: long-term memory is extracted **asynchronously**. Right after a turn, the raw event exists but the distilled preference might not yet, so a retrieve one second later can come back empty. Give the extraction a moment. That is the nature of long-term memory: it's the slow, considered kind, not the immediate transcript.

## 💸 A note on cost

AgentCore Memory is **serverless and consumption-based**, there is no fixed monthly fee just for having a memory store. You pay on three axes: short-term events written, long-term records stored, and retrieval calls. For a demo like this it rounds to cents.

The nice part is that the rest of the stack is the same kind of thing. The AgentCore **Runtime** (in the serverless microVM mode we use) bills CPU and memory only while a session is running, I/O wait is free, so with no one talking to it there is effectively no idle compute charge. The **ECR** image is just storage, a few cents per month. Left alone, this whole stack costs almost nothing; you pay when someone actually uses it.

## 📱 Next step: add a WhatsApp channel with AWS End User Messaging

Here is where the design pays off. Once memory is keyed to the user and not to the channel, **adding a third channel is mostly plumbing.** The memory doesn't change at all.

Imagine a WhatsApp channel using **AWS End User Messaging** (Social). The shape would be:

1. A user messages your WhatsApp business number. **AWS End User Messaging** receives the inbound message and publishes it (via `Amazon SNS`) to a Lambda.
2. The Lambda is the third agent. It runs the same shopping logic, calling the same `searchProducts` tool the other two channels use.
3. **The identity question is the whole game again.** WhatsApp identifies the user by phone number, not by a Cognito `sub`. So you need a mapping from phone number to your app's user identity, for example a small `DynamoDB` table populated during an opt-in or account-linking step. Once you resolve the phone number to the Cognito `sub`, you set that as the `actorId`.
4. From there it's the pattern you've already seen twice: retrieve `/preferences/{actorId}/` and `/facts/{actorId}/`, inject them into the prompt, generate a reply, send it back through **AWS End User Messaging**, and write the turn to memory.

The user starts on WhatsApp on the train, continues by voice at home, finishes in the web chat, and the assistant remembers throughout. No channel owns the memory. The **user** owns the memory, and every channel is just a different door into the same context.

That mapping step (phone number to user identity) is the only real new work. Everything else, the memory store, the namespaces, the retrieve-and-inject pattern, is already built. That is the point of keying memory to the user: **new channels are additive, not a rewrite.**

## 🧠 What I take away from this project

Three things stood out building this.

**Identity is the design.** The single most important decision wasn't which memory strategy to use or how to call the SDK. It was keying memory to the Cognito `sub` instead of the runtime session. Get that right and omnichannel falls out almost for free. Get it wrong and you have two agents with amnesia and no amount of SDK cleverness fixes it.

**One memory, many integrations.** The voice agent and the chat agent integrate with AgentCore Memory differently, one uses a native session manager to write, the other writes manually, and both retrieve and inject by hand. That asymmetry is fine. The memory is the shared contract; how each runtime reads and writes it is a local detail.

**It's all one backend, still.** The memory store, its IAM, its wiring into both the voice runtime and the chat handler, are all just `CDK` constructs sitting next to the data and auth. Adding cross-channel memory didn't mean a new system to operate. It meant a few more constructs in the same `npx ampx sandbox` deploy.

**Your `Amazon DynamoDB` database was an AI tool. The agent that talks to it became serverless. And now, whichever channel you reach for, it's the same assistant, and it remembers you.**

{% github https://github.com/davide-desio-eleva/dynamodbvector %}

## 🙋 Who am I
I'm [D. De Sio](https://www.linkedin.com/in/desiodavide) and I work as a Head of Software Engineering in [Eleva](https://eleva.it/).
As of September 2026, I’m an [AWS Certified Solution Architect Professional](https://www.credly.com/badges/9929fdf2-7a3d-4013-9de6-57c80e4920b9/public_url) and [AWS Certified DevOps Engineer Professional](https://www.credly.com/badges/8c5a1487-191b-429e-8c2d-7cee43bf316b/public_url), but also a [User Group Leader (in Pavia)](https://www.linkedin.com/company/aws-user-group-pavia/), an **AWS Community Builder** and, last but not least, a #serverless enthusiast.
