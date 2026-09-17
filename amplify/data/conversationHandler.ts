import { handleConversationTurnEvent } from "@aws-amplify/backend-ai/conversation/runtime";
import type { ConversationTurnEvent } from "@aws-amplify/backend-ai/conversation/runtime";
import {
  BedrockAgentCoreClient,
  RetrieveMemoryRecordsCommand,
  CreateEventCommand,
} from "@aws-sdk/client-bedrock-agentcore";

// ── Config ──────────────────────────────────────────────────────────────
// AgentCore Memory is the shared long-term store between the voice agent and
// this text chat agent. The shared key is the Cognito `sub` (actorId), so a
// preference learned in one channel is available in the other.

const MEMORY_ID = process.env.MEMORY_ID;
const MEMORY_REGION = process.env.MEMORY_REGION ?? process.env.AWS_REGION;

const memoryClient = MEMORY_ID
  ? new BedrockAgentCoreClient({ region: MEMORY_REGION })
  : undefined;

// Namespaces configured on the memory strategies in backend.ts.
// `{actorId}` is substituted with the concrete Cognito sub at query time.
const PREFERENCES_NAMESPACE = "/preferences";
const FACTS_NAMESPACE = "/facts";

// ── Structured logging ────────────────────────────────────────────────────
// The voice agent runs on AgentCore Runtime and gets rich OpenTelemetry traces
// for free. This conversation handler runs on a Lambda whose runtime is managed
// by the AI Kit, so instead of tracing we emit structured JSON log lines. They
// land in CloudWatch Logs and are queryable in Logs Insights (e.g. count how
// often memory was injected). We log counts and a short actor prefix only, never
// the remembered content itself, which is personal.
function logMemoryEvent(
  event: string,
  fields: Record<string, string | number | boolean>
): void {
  console.log(JSON.stringify({ component: "memory", event, ...fields }));
}

// ── JWT helpers ─────────────────────────────────────────────────────────
// The AI Kit forwards the caller's Cognito access token on the conversation
// event headers. We only need the `sub` claim to key the memory, so we decode
// the payload without verifying the signature (AppSync already authenticated
// the request before it reached this handler).

function decodeJwtSub(authorizationHeader?: string): string | undefined {
  if (!authorizationHeader) return undefined;
  const token = authorizationHeader.replace(/^Bearer\s+/i, "").trim();
  const parts = token.split(".");
  if (parts.length < 2) return undefined;
  try {
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const decoded = Buffer.from(payload, "base64").toString("utf-8");
    const claims = JSON.parse(decoded) as { sub?: string };
    return claims.sub;
  } catch {
    return undefined;
  }
}

function resolveActorId(event: ConversationTurnEvent): string | undefined {
  const headers = event.request?.headers ?? {};
  // Header names arrive lowercased through AppSync.
  const auth = headers["authorization"] ?? headers["Authorization"];
  return decodeJwtSub(auth);
}

// ── Memory retrieval ────────────────────────────────────────────────────

async function retrieveMemory(
  actorId: string,
  namespacePrefix: string,
  searchQuery: string
): Promise<string[]> {
  if (!memoryClient || !MEMORY_ID) return [];
  const namespace = `${namespacePrefix}/${actorId}/`;
  try {
    const response = await memoryClient.send(
      new RetrieveMemoryRecordsCommand({
        memoryId: MEMORY_ID,
        namespace,
        searchCriteria: {
          searchQuery,
          topK: 5,
        },
      })
    );
    return (response.memoryRecordSummaries ?? [])
      .map((r) => r.content?.text)
      .filter((t): t is string => Boolean(t));
  } catch (err) {
    console.warn(`Memory retrieval failed for namespace ${namespace}:`, err);
    return [];
  }
}

// ── Read the latest user message ─────────────────────────────────────────
// We use it both as the semantic search query for memory retrieval and as the
// turn we persist back so the long-term strategies can extract preferences and
// facts. The conversation event doesn't carry the message body, so we fetch the
// current message with a small GraphQL query using only public event fields
// (endpoint, auth header, and the generated getMessage query name).

async function getLatestUserText(
  event: ConversationTurnEvent
): Promise<string | undefined> {
  const query = `
    query GetMessage($id: ${event.messageHistoryQuery.getQueryInputTypeName}!) {
      ${event.messageHistoryQuery.getQueryName}(id: $id) {
        role
        content {
          text
        }
      }
    }`;
  try {
    const response = await fetch(event.graphqlApiEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: event.request.headers.authorization,
      },
      body: JSON.stringify({
        query,
        variables: { id: event.currentMessageId },
      }),
    });
    const body = (await response.json()) as {
      data?: Record<
        string,
        { role: string; content?: Array<{ text?: string }> } | null
      >;
    };
    const message = body.data?.[event.messageHistoryQuery.getQueryName];
    if (!message?.content) return undefined;
    const text = message.content
      .map((c) => c.text)
      .filter(Boolean)
      .join(" ")
      .trim();
    return text || undefined;
  } catch (err) {
    console.warn("Failed to fetch current message text:", err);
    return undefined;
  }
}

// ── Persist the user turn so long-term memory can extract from it ─────────

async function persistUserTurn(
  actorId: string,
  conversationId: string,
  userText: string
): Promise<void> {
  if (!memoryClient || !MEMORY_ID) return;
  try {
    await memoryClient.send(
      new CreateEventCommand({
        memoryId: MEMORY_ID,
        actorId,
        sessionId: conversationId,
        eventTimestamp: new Date(),
        payload: [
          {
            conversational: {
              role: "USER",
              content: { text: userText },
            },
          },
        ],
      })
    );
  } catch (err) {
    console.warn("Failed to persist user turn to memory:", err);
  }
}

// ── Inject remembered context into the system prompt ──────────────────────

function buildMemoryPreamble(
  preferences: string[],
  facts: string[]
): string | undefined {
  if (preferences.length === 0 && facts.length === 0) return undefined;
  const lines: string[] = [
    "Here is what you remember about this customer from previous conversations (across both voice and chat). Use it to personalize your suggestions, but confirm before assuming it still applies.",
  ];
  if (preferences.length > 0) {
    lines.push("", "Known preferences:");
    lines.push(...preferences.map((p) => `- ${p}`));
  }
  if (facts.length > 0) {
    lines.push("", "Known facts:");
    lines.push(...facts.map((f) => `- ${f}`));
  }
  return lines.join("\n");
}

// ── Handler ───────────────────────────────────────────────────────────────

export const handler = async (event: ConversationTurnEvent) => {
  const actorId = resolveActorId(event);

  // No memory configured, or we couldn't identify the user: behave exactly
  // like the default handler.
  if (memoryClient && MEMORY_ID && actorId) {
    const userText = await getLatestUserText(event);
    const searchQuery = userText ?? "customer preferences and interests";

    const [preferences, facts] = await Promise.all([
      retrieveMemory(actorId, PREFERENCES_NAMESPACE, searchQuery),
      retrieveMemory(actorId, FACTS_NAMESPACE, searchQuery),
    ]);

    const preamble = buildMemoryPreamble(preferences, facts);
    if (preamble) {
      event.modelConfiguration.systemPrompt = `${preamble}\n\n${event.modelConfiguration.systemPrompt}`;
    }

    logMemoryEvent("retrieved", {
      actor: actorId.slice(0, 8),
      preferences: preferences.length,
      facts: facts.length,
      injected: Boolean(preamble),
    });

    // Persist the incoming user turn so the long-term strategies can extract
    // new preferences/facts from it.
    if (userText) {
      await persistUserTurn(actorId, event.conversationId, userText);
      logMemoryEvent("persisted", { actor: actorId.slice(0, 8) });
    }
  }

  return handleConversationTurnEvent(event);
};
