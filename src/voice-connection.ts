/**
 * Builds the WebSocket connection to the voice agent.
 *
 * Two modes:
 *  - Local dev: connect directly to the local Strands agent on port 8080.
 *  - Deployed: connect to the AgentCore Runtime WebSocket endpoint using the
 *    signed-in user's Cognito JWT as an OAuth bearer token.
 *
 * Browsers can't set custom headers on a WebSocket handshake, so AgentCore
 * accepts the bearer token via the Sec-WebSocket-Protocol header: the token is
 * base64url-encoded and passed as the subprotocol
 * `base64UrlBearerAuthorization.<token>` alongside the sentinel subprotocol
 * `base64UrlBearerAuthorization`. This matches the JWT authorizer configured on
 * the runtime (the Amplify Cognito User Pool).
 */
import { fetchAuthSession } from "aws-amplify/auth";
import outputs from "../amplify_outputs.json";

const LOCAL_WS_URL = "ws://127.0.0.1:8080/ws";

type CustomOutputs = {
  custom?: {
    VoiceAgentRuntimeArn?: string;
    VoiceAgentRegion?: string;
  };
};

const custom = (outputs as CustomOutputs).custom ?? {};

export function hasDeployedAgent(): boolean {
  return Boolean(custom.VoiceAgentRuntimeArn && custom.VoiceAgentRegion);
}

/** Session id (>= 33 chars, unique per conversation). */
function generateSessionId(): string {
  return crypto.randomUUID() + crypto.randomUUID();
}

/** base64url-encode a string (no padding, URL-safe alphabet). */
function base64url(input: string): string {
  return btoa(input).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

/**
 * Best-effort decode of the `sub` claim from a Cognito JWT (no verification).
 * The runtime's JWT authorizer already validated the token; we only read the
 * identity so the voice agent can key its memory to the same actorId the chat
 * agent uses (the Cognito sub).
 */
function decodeJwtSub(token: string): string | undefined {
  try {
    const payload = token.split(".")[1];
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(normalized);
    return JSON.parse(json).sub as string | undefined;
  } catch {
    return undefined;
  }
}

export interface VoiceConnectionConfig {
  url: string;
  /** Subprotocols to pass to `new WebSocket(url, protocols)`, or undefined. */
  protocols?: string[];
}

/**
 * Returns the WebSocket URL (and optional subprotocols) to connect to.
 * Local dev: plain ws:// with no subprotocols.
 * Deployed: wss:// AgentCore endpoint with the Cognito bearer token embedded
 * in the Sec-WebSocket-Protocol subprotocol.
 */
export async function buildVoiceConnection(): Promise<VoiceConnectionConfig> {
  if (!hasDeployedAgent()) {
    return { url: LOCAL_WS_URL };
  }

  const runtimeArn = custom.VoiceAgentRuntimeArn!;
  const region = custom.VoiceAgentRegion!;
  const sessionId = generateSessionId();

  // The signed-in user's Cognito access token (validated by the runtime's
  // JWT authorizer).
  const session = await fetchAuthSession();
  const token = session.tokens?.accessToken?.toString();
  if (!token) {
    throw new Error("No Cognito token available. Are you signed in?");
  }

  // The Cognito sub keys the shared AgentCore Memory. AgentCore does not forward
  // the caller's JWT to the container, so we pass the sub explicitly as a custom
  // runtime header. Values sent as `X-Amzn-Bedrock-AgentCore-Runtime-Custom-*`
  // query params are delivered to the container as headers of the same name.
  const actorId = session.tokens?.idToken?.payload?.sub ?? decodeJwtSub(token);

  const hostname = `bedrock-agentcore.${region}.amazonaws.com`;
  const encodedArn = encodeURIComponent(runtimeArn);
  let url =
    `wss://${hostname}/runtimes/${encodedArn}/ws` +
    `?qualifier=DEFAULT` +
    `&X-Amzn-Bedrock-AgentCore-Runtime-Session-Id=${encodeURIComponent(sessionId)}`;
  if (actorId) {
    url +=
      `&X-Amzn-Bedrock-AgentCore-Runtime-Custom-actorId=${encodeURIComponent(actorId)}`;
  }

  const protocols = [
    `base64UrlBearerAuthorization.${base64url(token)}`,
    "base64UrlBearerAuthorization",
  ];

  return { url, protocols };
}
