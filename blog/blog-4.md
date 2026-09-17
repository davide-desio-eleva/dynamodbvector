# 🏃 TL;DR

Across this series I built up a small but real system: [semantic product search on Amazon DynamoDB Vector Search](https://dev.to/aws-builders/your-database-is-an-ai-tool-semantic-search-with-amazon-dynamodb-vector-search-46ff), a [voice agent deployed on Amazon Bedrock AgentCore Runtime](https://dev.to/aws-builders/deploying-a-real-time-voice-agent-with-agentcore-runtime-and-amplify-gen-2-45bl), and a [shared long-term memory](https://dev.to/aws-builders) that makes the voice and text agents feel like one omnichannel assistant.

So now I have multiple agents, on two different runtimes, reasoning over multiple steps, calling tools, reading and writing memory. It works. But there's a question that gets louder the more of this you build:

**When something goes wrong, why did the agent do that?**

A voice agent that stalls before speaking, a tool that returns odd results, a memory that should have been recalled but wasn't. With plain logs you're guessing. This article is about replacing the guessing with **observability**: tracing what the agents actually do, step by step, using **Amazon Bedrock AgentCore Observability** and the OpenTelemetry conventions, all wired from the same Amplify Gen 2 backend.

And the voice agent turns out to be the interesting case, because a real-time bidirectional agent traces very differently from a request/response one.

{% github https://github.com/davide-desio-eleva/dynamodbvector %}

## 🔭 What "observing an agent" actually means

Classic observability is CPU, memory, latency. Useful, but it doesn't tell you why an agent gave a bad answer. Agent observability is about the **reasoning chain**: each model call, each tool invocation, each retrieval becomes a **span**, and the spans nest into a **trace** that is the whole story of one request.

The industry has largely standardized this around the OpenTelemetry **GenAI semantic conventions**: attributes like `gen_ai.operation.name`, `gen_ai.request.model`, `gen_ai.usage.input_tokens`. Strands emits these out of the box, which is what makes the rest of this article mostly configuration rather than code.

## 🧩 Turning it on, from the same backend

The nice part: because the voice agent already runs on **AgentCore Runtime**, the runtime ships with a managed **AWS Distro for OpenTelemetry (ADOT)** pipeline that delivers telemetry to **Amazon CloudWatch GenAI Observability**. I don't run a collector. I opt in.

There are three moving pieces.

**1. Enable CloudWatch Transaction Search (once per account).** This is what lets CloudWatch index the spans for search. You can index 1% of traces at no cost, which is plenty for a demo. It's an account-level setting, not something in the stack.

**2. Put ADOT in the container and launch under it.** Two changes in `voice-agent/`. First, the dependency:

```txt
# requirements.txt — 0.18.0+ is required for unified telemetry
aws-opentelemetry-distro==0.19.0
```

Second, and this is the one that actually matters, the container must start **under the auto-instrumentation wrapper**. Running `python agent.py` directly skips ADOT entirely:

```dockerfile
# Launch under the OpenTelemetry auto-instrumentation wrapper so the ADOT SDK
# picks up the OTEL_* env vars and exports the spans Strands emits.
CMD ["opentelemetry-instrument", "python", "agent.py"]
```

**3. Configure the runtime, in `backend.ts`.** Since Amplify Gen 2 is CDK, the observability configuration lives right on the `CfnRuntime` next to everything else:

```typescript
environmentVariables: {
  // ...existing config
  AGENT_OBSERVABILITY_ENABLED: "true",
  OTEL_PYTHON_DISTRO: "aws_distro",
  OTEL_PYTHON_CONFIGURATOR: "aws_configurator",
  OTEL_RESOURCE_ATTRIBUTES: "service.name=voiceShoppingAgent",
  // Deliver spans to this agent's own log group (unified telemetry)
  // instead of the shared aws/spans group. Requires ADOT >= 0.18.0.
  UNIFIED_TRACES_DESTINATION_ENABLED: "true",
},
```

The runtime's execution role also needs permission to ship spans and metrics (`xray:PutTraceSegments`, `xray:PutSpans`, `cloudwatch:PutMetricData`, and `logs:PutResourcePolicy` for the unified destination). That's it. The agent code that emits the spans didn't change; I just registered the Strands tracer:

```python
from strands.telemetry import StrandsTelemetry

strands_telemetry = StrandsTelemetry()
# In the container, ADOT exports for us. Locally, print spans to the console.
if not os.getenv("CONTAINER_ENV"):
    strands_telemetry.setup_console_exporter()
```

## 🎙️ The interesting part: tracing a voice agent

Here's where a real-time voice agent stops looking like a normal LLM app.

A request/response agent produces a tidy trace: one request, a few model and tool spans, done. A **`BidiAgent`** running Nova Sonic is a single long-lived connection that streams audio both ways, and its trace reflects that. The session is one trace, with a `bidi_session` parent and children for each phase:

```
bidi_session voiceShoppingAgent
├── bidi_connect            (establishing the model connection)
├── bidi_response           (one response from the model)
├── execute_tool search_products
├── bidi_response
└── bidi_connection_restart (a reconnect after a provider timeout)
```

A few things are worth reading closely on the spans, and they're all things I confirmed on a real session.

**`time_to_first_audio`.** This attribute is the latency the user actually feels: how long from the start of a response to the first chunk of audio. In a voice UI this matters more than total duration. A long session can be perfectly healthy; a slow first audio chunk is a bad experience.

**Interruptions are first-class.** When you talk over the assistant (a barge-in), that's not an error, it's a `bidi_interruption` event on the session span, and the response it cut off closes with a finish reason of `interrupted`. I also added a small hook to count them:

```python
class SessionStats(HookProvider):
    def register_hooks(self, registry: HookRegistry) -> None:
        registry.add_callback(BidiInterruptionEvent, self._on_interruption)
        registry.add_callback(BidiAfterConnectionRestartEvent, self._on_restart)
```

A rising interruption rate usually means the assistant's responses are too long for voice, people cut in. That's a product signal you can only see if you measure it.

**The Nova Sonic quirk.** This one will confuse you the first time. On a single spoken turn, I counted **66 `bidi_response` spans** for a handful of actual turns. That is expected: Nova Sonic emits one response span per content block, and all but the last close as `interrupted`. So if you try to count spoken turns by counting response spans, the numbers look broken. You count turns from interruption events and finish reasons instead. Knowing this up front saves you an afternoon of confusion.

## 🔒 A privacy detail that ties back to memory

There's a subtlety that connects directly to the previous article. Strands captures the system prompt verbatim on the session span, as `gen_ai.system_instructions`. And in the memory article, I inject the user's remembered preferences into that system prompt. So without care, the traces would leak a user's personal context.

The fix is one environment variable that turns on redaction:

```typescript
// The voice agent injects the user's remembered preferences into the system
// prompt; redact sensitive span attributes so that context never lands in a trace.
OTEL_SEMCONV_STABILITY_OPT_IN: "gen_ai_unredacted_attributes=",
```

With that set, the sensitive attributes export as `[REDACTED]`. On my traced session the system message shows exactly that: `"role":"system","content":"[REDACTED]"`, and so do the tool payloads. The shape of the reasoning is fully visible; the personal content is not. That's the balance you want in production: observe the behavior, not the private data.

## 💬 The other runtime: observing the chat agent

The voice agent gets rich distributed tracing because it runs on AgentCore Runtime. The text chat agent runs on a **Lambda** managed by the Amplify AI Kit, and there the honest answer is different: I don't force OpenTelemetry into a runtime I don't own. I observe it the Lambda-native way, structured logs and the built-in Lambda metrics (invocations, duration, errors).

So the conversation handler emits structured log lines I can query in CloudWatch Logs Insights, without ever logging the remembered content itself:

```typescript
logMemoryEvent("retrieved", {
  actor: actorId.slice(0, 8),
  preferences: preferences.length,
  facts: facts.length,
  injected: Boolean(preamble),
});
```

This is a deliberate asymmetry, and it echoes the theme from the memory article: **two runtimes, two observability models.** The voice agent gets OTel traces; the chat agent gets structured logs and metrics. You meet each runtime where it is rather than forcing one pattern everywhere.

## 🗺️ Reading it in CloudWatch

Once a session runs, the data lands in the **CloudWatch GenAI Observability** console (the Bedrock AgentCore view), which gives you three angles without building anything:

- **Agents view**: your agents and their runtime metrics.
- **Sessions view**: each session, with token usage and duration.
- **Traces view**: the `bidi_session` waterfall, where you can open a span and see the tool call, the timings, the finish reasons.

That "without building anything" is the point. It's tempting to build an observability page into the web app, but that would be reimplementing, worse, a console AWS already gives you, and it would mix the end-user app with an operator tool. The observability lives where operators look, not inside the product.

## 🔮 What's next: from watching to judging

Tracing tells you what happened. It doesn't tell you whether the answer was any good. A trace can be a perfectly healthy waterfall around a completely wrong recommendation.

The natural next step is **evaluation**: scoring the agent's actual quality, is the search relevant to what the user asked, did the agent use the memory when it should have, was the response correct. And here's the neat part: **AgentCore Evaluations reads the very same Strands telemetry** we just turned on. The traces aren't only for debugging by eye; they're the substrate an evaluation service scores. That's a whole article of its own, and a good place to pick up next.

## 🧠 What I take away from this project

**Observability was mostly opt-in, not build.** Because the voice agent already ran on AgentCore Runtime and Strands already speaks OpenTelemetry, turning on rich tracing was a dependency, a launch command, and a few environment variables. The single real gotcha was launching under `opentelemetry-instrument`; miss that and you get silence.

**Real-time agents trace differently, and that's the story.** The `bidi_session` tree, `time_to_first_audio`, interruptions as first-class events, and Nova Sonic's one-span-per-content-block behavior are not edge cases, they're the normal shape of a voice agent's telemetry. Reading them correctly is a skill worth having before you need it at 2am.

**Observe behavior, not people.** The same system prompt that carries a user's remembered preferences would carry them straight into a trace. Redaction keeps the reasoning visible and the person private.

**Your `Amazon DynamoDB` database was an AI tool. The agent became serverless, then omnichannel. And now you can see exactly what it's doing, one span at a time.**

{% github https://github.com/davide-desio-eleva/dynamodbvector %}

## 🙋 Who am I
I'm [D. De Sio](https://www.linkedin.com/in/desiodavide) and I work as a Head of Software Engineering in [Eleva](https://eleva.it/).
As of September 2026, I’m an [AWS Certified Solution Architect Professional](https://www.credly.com/badges/9929fdf2-7a3d-4013-9de6-57c80e4920b9/public_url) and [AWS Certified DevOps Engineer Professional](https://www.credly.com/badges/8c5a1487-191b-429e-8c2d-7cee43bf316b/public_url), but also a [User Group Leader (in Pavia)](https://www.linkedin.com/company/aws-user-group-pavia/), an **AWS Community Builder** and, last but not least, a #serverless enthusiast.

## 🎉 AWS Community Day Italy

The full agenda for [AWS Community Day Italy](https://www.awscommunityday.it/) is out!

If you'd love to hear what the community has been working on, what they've learned, and what they want to share, come join us in Rome on October 2nd. 