# 🏃 TL;DR

In the [previous article](https://dev.to/aws-builders/your-database-is-an-ai-tool-semantic-search-with-amazon-dynamodb-vector-search-46ff) I built a semantic product search on top of `Amazon DynamoDB` Vector Search, and then gave that capability to an AI agent as a tool. One of the things I explored at the end was a voice agent: a Strands `BidiAgent` powered by `Amazon Nova Sonic` that could search the catalog by voice.

That voice agent ran locally. A Python server on my laptop, a WebSocket, my microphone. Great for a demo, but it lives on my machine.

**So the question for this article is: how do I actually deploy it?**

I want the voice agent to run on AWS, I want it authenticated with the same users my app already has, and I want it to be part of the same `Amplify Gen 2` backend as everything else. No separate project, no separate auth, no separate deploy command.

It turns out this fits together really nicely with **Amazon Bedrock AgentCore Runtime**. Let me walk through it.

{% github https://github.com/davide-desio-eleva/dynamodbvector %}

## 🎙️ Where we left off

Quick recap of the voice agent: it's a Python app: a FastAPI server that exposes a WebSocket on `/ws`, and a Strands `BidiAgent` wired to `Amazon Nova Sonic` with our `search_products` tool.

```python
from fastapi import FastAPI, WebSocket
from strands.experimental.bidi import BidiAgent
from strands.experimental.bidi.models import BidiNovaSonicModel
from strands import tool

@tool
def search_products(query: str) -> str:
    """Search the product catalog using natural language."""
    # Nova Micro parses the query, Titan embeds it,
    # DynamoDB SearchVectors finds the matches, we filter by price.
    ...

sonic_model = BidiNovaSonicModel(model_id="amazon.nova-2-sonic-v1:0", ...)

app = FastAPI()

@app.websocket("/ws")
async def voice_chat(websocket: WebSocket):
    agent = BidiAgent(model=sonic_model, tools=[search_products], ...)
    await websocket.accept()
    await agent.run(
        inputs=[websocket.receive_json],
        outputs=[websocket.send_json],
    )
```

Locally I ran this with `uvicorn`, the browser connected to `ws://127.0.0.1:8080/ws`, and everything worked. 
**Now I want the exact same code running on AWS.**

## 🧩 What is Amazon Bedrock AgentCore Runtime, and why it fits

`Amazon Bedrock AgentCore Runtime` is a serverless runtime purpose-built for hosting AI agents. It's framework-agnostic (Strands, LangGraph, CrewAI, whatever) and, importantly for us, it supports **bidirectional streaming over WebSocket**, which is exactly what a real-time voice agent needs.

`Amazon Bedrock AgentCore Runtime` contract is simple, you give it a container that listens on **port 8080** and exposes a WebSocket at **`/ws`**, plus a `/ping` health check. That's already how our agent is written. 

**`Amazon Bedrock AgentCore`  handles the rest: session isolation, scaling, authentication, and the public WebSocket endpoint.**

So the plan is:

1. Package the voice agent as a docker container.
2. Deploy it to AgentCore Runtime.
3. **Authenticate it with the Cognito user pool Amplify already created**.
4. Connect the browser to it.

And because **`Amplify Gen 2` is CDK under the hood**, I can do all of this inside the same `amplify/backend.ts` I already have, without a second project or a specific `CDK`/`CloudFormation`/Terraform project.

## 📦 Step 1: containerize the agent

`Amazon Bedrock AgentCore Runtime` runs **ARM64** containers. 
The Dockerfile is minimal:

```dockerfile
FROM --platform=linux/arm64 python:3.12-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY agent.py .

ENV CONTAINER_ENV=true
EXPOSE 8080
CMD ["python", "agent.py"]
```

The only change to the agent itself is binding to `0.0.0.0` when running in the container (locally it stayed on `127.0.0.1`):

```python
host = "0.0.0.0" if os.getenv("CONTAINER_ENV") else "127.0.0.1"
uvicorn.run(app, host=host, port=8080)
```

## 🏗️ Step 2: deploy it from the Amplify backend

Here's the part I like: again, since `Amplify Gen 2` backends are `CDK` constructs, I can build the image and create the runtime right in my `backend.ts`.

First, we should build the ARM64 image and push it to `Amazon ECR`. The `CDK` `DockerImageAsset` does all of that during deployment, no manual `docker build` or `docker push`:

```typescript
import * as ecrAssets from "aws-cdk-lib/aws-ecr-assets";

const voiceImage = new ecrAssets.DockerImageAsset(voiceStack, "VoiceAgentImage", {
  directory: path.join(__dirname, "..", "voice-agent"),
  platform: ecrAssets.Platform.LINUX_ARM64,
});
```

Then we need an execution role for the runtime: it needs to pull the image, call `Amazon Bedrock` (`Amazon Nova Sonic 2` for voice, plus `Amazon Nova Micro` and `Amazon Titan Embeddings` for the search tool), and run `SearchVectors` on the DynamoDB table:

```typescript
const voiceRuntimeRole = new iam.Role(voiceStack, "VoiceAgentRuntimeRole", {
  assumedBy: new iam.ServicePrincipal("bedrock-agentcore.amazonaws.com", {
    conditions: { StringEquals: { "aws:SourceAccount": account } },
  }),
});

voiceImage.repository.grantPull(voiceRuntimeRole);
voiceRuntimeRole.addToPolicy(new iam.PolicyStatement({
  actions: ["ecr:GetAuthorizationToken"],
  resources: ["*"],
}));

voiceRuntimeRole.addToPolicy(new iam.PolicyStatement({
  actions: [
    "bedrock:InvokeModel",
    "bedrock:InvokeModelWithBidirectionalStream",
  ],
  resources: [
    "arn:aws:bedrock:*::foundation-model/amazon.nova-2-sonic-v1:0",
    "arn:aws:bedrock:*::foundation-model/amazon.titan-embed-text-v2:0",
    "arn:aws:bedrock:*::foundation-model/amazon.nova-micro-v1:0",
    `arn:aws:bedrock:*:${account}:inference-profile/eu.amazon.nova-micro-v1:0`,
  ],
}));

voiceRuntimeRole.addToPolicy(new iam.PolicyStatement({
  actions: ["dynamodb:SearchVectors", "dynamodb:GetItem"],
  resources: [productsTable.tableArn, `${productsTable.tableArn}/index/*`],
}));
```

And finally we need the runtime itself. Here I deliberately reach for the L1 `CfnRuntime` construct. Level 1 (L1) constructs map directly one-to-one to raw CloudFormation resources, while Level 2 (L2) constructs provide higher-level, object-oriented abstractions with built-in security best practices and helper methods. For a service this new I prefer the L1: it maps straight onto the `CloudFormation` resource, so what I write is exactly what gets deployed, with no abstraction deciding things for me.

```typescript
import { CfnRuntime } from "aws-cdk-lib/aws-bedrockagentcore";

const voiceRuntime = new CfnRuntime(voiceStack, "VoiceAgentRuntime", {
  agentRuntimeName: "voiceShoppingAgent",
  agentRuntimeArtifact: {
    containerConfiguration: { containerUri: voiceImage.imageUri },
  },
  networkConfiguration: { networkMode: "PUBLIC" },
  protocolConfiguration: "HTTP",
  roleArn: voiceRuntimeRole.roleArn,
  environmentVariables: {
    CONTAINER_ENV: "true",
    TABLE_NAME: productsTable.tableName,
    BEDROCK_REGION: "eu-north-1",
    // ...model ids
  },
  authorizerConfiguration: {
    customJwtAuthorizer: {
      discoveryUrl,
      allowedClients: [userPoolClient.userPoolClientId],
    },
  },
});
```

That `protocolConfiguration: "HTTP"` is worth a note. The valid protocol values are `HTTP`, `A2A`, `AGUI` and `MCP`, there is no `WEBSOCKET` value. Bidirectional streaming over WebSocket runs **on top of the `HTTP` server protocol**: the container exposes `/ws`, AgentCore speaks WebSocket to the client, but as far as the runtime configuration is concerned, the protocol is `HTTP`.

One detail on the execution role: alongside `grantPull()` (which covers `BatchGetImage` and `GetDownloadUrlForLayer` on the repository) the role also needs `ecr:GetAuthorizationToken`, and that action requires a `"*"` resource. Both are in the role above so the runtime can pull the image.

## 🔐 Step 3: reuse the Amplify Cognito user pool

This is where the "same backend" idea pays off as ny app already has authentication: `Amplify` created a `Amazon Cognito` user pool and users sign in to use the chat and search. I don't want a second identity system for the voice agent.

`AgentCore Runtime` supports **JWT inbound authorization**. You point it at an OIDC discovery URL and a list of allowed clients. An `Amazon Cognito` user pool is also an OIDC provider, so I can wire the runtime straight to it:

```typescript
const userPool = backend.auth.resources.userPool;
const userPoolClient = backend.auth.resources.userPoolClient;

const discoveryUrl =
  `https://cognito-idp.${region}.amazonaws.com/` +
  `${userPool.userPoolId}/.well-known/openid-configuration`;

// ...passed into the runtime's authorizerConfiguration.customJwtAuthorizer
```

Now the same user who is signed into the app can authenticate to the voice agent, with no extra setup. The token they already have is the token the runtime accepts.

## 🔄 Granting the user permission to invoke the runtime

The signed-in user connects to the runtime, so the `Amazon Cognito` **authenticated role** needs permission to invoke it. There's a nice detail in how you wire this up: the voice stack already depends on the auth stack (it reads the user pool), so you want the dependency to stay one-directional. The clean way is to define the policy **inside the voice stack** and attach it to the existing auth role by reference:

```typescript
new iam.Policy(voiceStack, "VoiceAgentInvokePolicy", {
  roles: [backend.auth.resources.authenticatedUserIamRole],
  statements: [
    new iam.PolicyStatement({
      actions: [
        "bedrock-agentcore:InvokeAgentRuntime",
        "bedrock-agentcore:InvokeAgentRuntimeWithWebSocketStream",
      ],
      resources: [
        voiceRuntime.attrAgentRuntimeArn,
        `${voiceRuntime.attrAgentRuntimeArn}/*`,
      ],
    }),
  ],
});
```

The policy is created in the voice stack, which is allowed to reference the auth role, while the auth stack never needs to know about the voice stack. The dependency flows in a single direction.

## 🌐 Step 4: connect the browser

The last piece is the frontend. Locally the browser connected to `ws://127.0.0.1:8080/ws`. Deployed, it connects to the `AgentCore` endpoint:

```text
wss://bedrock-agentcore.<region>.amazonaws.com/runtimes/<runtimeArn>/ws
```

The interesting question is authentication. `AgentCore` accepts `SigV4` (signed headers or a presigned URL) or an OAuth bearer token. From a **browser**, `SigV4` on a WebSocket is awkward, because the browser's WebSocket API doesn't let you set custom headers on the handshake.

AWS documents a clean workaround for exactly this case: pass the bearer token through the `Sec-WebSocket-Protocol` header. The token is base64url-encoded and sent as a subprotocol, alongside a sentinel subprotocol:

```typescript
import { fetchAuthSession } from "aws-amplify/auth";

const session = await fetchAuthSession();
const token = session.tokens?.accessToken?.toString();

const base64url = (s: string) =>
  btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");

const url =
  `wss://bedrock-agentcore.${region}.amazonaws.com` +
  `/runtimes/${encodeURIComponent(runtimeArn)}/ws` +
  `?qualifier=DEFAULT&X-Amzn-Bedrock-AgentCore-Runtime-Session-Id=${sessionId}`;

const protocols = [
  `base64UrlBearerAuthorization.${base64url(token)}`,
  "base64UrlBearerAuthorization",
];

const ws = new WebSocket(url, protocols);
```

That `Amazon Cognito` access token is exactly what the runtime's JWT authorizer validates. The user's `client_id` claim has to match the `allowedClients` we configured, which it does, because it's the same user pool client `Amplify` gave us.

From here on, the rest of the frontend doesn't change at all. The same code that captured microphone audio, streamed PCM frames, and played back the agent's voice against the local server now works against AgentCore. Only the URL and the auth changed.

## 🗺️ The whole picture

Everything lives in one `Amplify Gen 2` backend and deploys with a single `npx ampx sandbox`:

![Image description](https://dev-to-uploads.s3.us-east-2.amazonaws.com/uploads/articles/eah7z7m8dscbbrzq5hut.png)

The browser signs in once with `Amazon Cognito`. That identity gets it into the app, into the search API, into the chat, and now into the voice agent too.

## 🧠 What I take away from this project

A couple of things stood out while building this.

The first is how little the agent code changed between local and deployed. The same FastAPI + Strands `BidiAgent` server ran on my laptop and, unchanged, inside `Amazon Bedrock AgentCore`. The container contract (port 8080, `/ws`, `/ping`) is simple enough that "make it a container" was the only real step.

**The second is the value of keeping it all in one backend. Because `Amplify Gen 2` is `CDK`, the runtime, its image, its `IAM`, and its wiring to `Amazon Cognito` are all just constructs next to my data and auth definitions. The voice agent isn't a separate system I have to operate, it's another resource in the same deploy, sharing the same users.**

The voice agent that used to live on my laptop now runs on AWS, authenticated with the users my app already had, deployed with the same command as everything else.

**Your `Amplify Gen 2` deployed `Amazon DynamoDb` database was already an AI tool.
Now the agent that talks to it is serverless and, thanks to `CDK`, it's wired to `Amplify Gen 2` deployments too.**

{% github https://github.com/davide-desio-eleva/dynamodbvector %}

## 🙋 Who am I
I'm [D. De Sio](https://www.linkedin.com/in/desiodavide) and I work as a Head of Software Engineering in [Eleva](https://eleva.it/).
As of September 2026, I’m an [AWS Certified Solution Architect Professional](https://www.credly.com/badges/9929fdf2-7a3d-4013-9de6-57c80e4920b9/public_url) and [AWS Certified DevOps Engineer Professional](https://www.credly.com/badges/8c5a1487-191b-429e-8c2d-7cee43bf316b/public_url), but also a [User Group Leader (in Pavia)](https://www.linkedin.com/company/aws-user-group-pavia/), an **AWS Community Builder** and, last but not least, a #serverless enthusiast.

![Image description](https://dev-to-uploads.s3.us-east-2.amazonaws.com/uploads/articles/szs4pqhg0xqpgkv88wpn.png)


## 🎉 AWS Community Day Italy

The full agenda for [AWS Community Day Italy](https://www.awscommunityday.it/) is out!

If you'd love to hear what the community has been working on, what they've learned, and what they want to share, come join us in Rome on October 2nd.