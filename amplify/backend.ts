import { defineBackend } from "@aws-amplify/backend";
import { auth } from "./auth/resource";
import { data, searchProductsHandler, chatHandler, crossRegionModel, novaLiteModel } from "./data/resource";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as cr from "aws-cdk-lib/custom-resources";
import * as ecrAssets from "aws-cdk-lib/aws-ecr-assets";
import { CfnRuntime } from "aws-cdk-lib/aws-bedrockagentcore";
import { Stack } from "aws-cdk-lib";
import * as path from "path";
import { fileURLToPath } from "url";

const backend = defineBackend({
  auth,
  data,
  searchProductsHandler,
  chatHandler,
});

// ─── DynamoDB Products table (on-demand, required for vector indexes) ───
const dataStack = backend.createStack("ProductsVectorStack");

const productsTable = new dynamodb.Table(dataStack, "ProductsTable", {
  tableName: `Products-${Stack.of(dataStack).stackName}`,
  partitionKey: { name: "ProductId", type: dynamodb.AttributeType.STRING },
  billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
});

// ─── Create vector index via AwsCustomResource (SDK call) ───────────────
// CloudFormation doesn't support VectorIndexes yet, so we use an SDK call
// to add the vector index via UpdateTable.
const createVectorIndex = new cr.AwsCustomResource(
  dataStack,
  "CreateVectorIndex",
  {
    onCreate: {
      service: "DynamoDB",
      action: "updateTable",
      parameters: {
        TableName: productsTable.tableName,
        VectorIndexUpdates: [
          {
            Create: {
              IndexName: "ProductEmbeddingIndex",
              VectorAttribute: { AttributeName: "Embedding" },
              Projection: { ProjectionType: "ALL" },
              Dimensions: 1024,
              DistanceFunction: "COSINE",
            },
          },
        ],
      },
      physicalResourceId: cr.PhysicalResourceId.of("ProductEmbeddingIndex"),
    },
    onDelete: {
      service: "DynamoDB",
      action: "updateTable",
      parameters: {
        TableName: productsTable.tableName,
        VectorIndexUpdates: [
          {
            Delete: {
              IndexName: "ProductEmbeddingIndex",
            },
          },
        ],
      },
    },
    policy: cr.AwsCustomResourcePolicy.fromStatements([
      new iam.PolicyStatement({
        actions: ["dynamodb:UpdateTable", "dynamodb:DescribeTable"],
        resources: [productsTable.tableArn],
      }),
    ]),
  }
);

createVectorIndex.node.addDependency(productsTable);

// ─── Grant the search Lambda access to DynamoDB + Bedrock ───────────────
const searchLambda = backend.searchProductsHandler.resources.lambda as lambda.Function;

// Override environment variables with actual table name
searchLambda.addEnvironment("TABLE_NAME", productsTable.tableName);

// DynamoDB read + SearchVectors permission
searchLambda.addToRolePolicy(
  new iam.PolicyStatement({
    actions: [
      "dynamodb:SearchVectors",
      "dynamodb:GetItem",
      "dynamodb:Query",
      "dynamodb:Scan",
    ],
    resources: [
      productsTable.tableArn,
      `${productsTable.tableArn}/index/*`,
    ],
  })
);

// Bedrock InvokeModel permission
searchLambda.addToRolePolicy(
  new iam.PolicyStatement({
    actions: ["bedrock:InvokeModel"],
    resources: [
      "arn:aws:bedrock:*::foundation-model/amazon.titan-embed-text-v2:0",
      "arn:aws:bedrock:*::foundation-model/amazon.nova-micro-v1:0",
      `arn:aws:bedrock:*:${Stack.of(dataStack).account}:inference-profile/eu.amazon.nova-micro-v1:0`,
    ],
  })
);

// ─── Export table name for the seed script ───────────────────────────────
backend.addOutput({
  custom: {
    ProductsTableName: productsTable.tableName,
  },
});

// ─── Grant the chat handler Lambda access to Bedrock Nova Lite ──────────
const chatLambda = backend.chatHandler.resources.lambda as lambda.Function;
chatLambda.addToRolePolicy(
  new iam.PolicyStatement({
    actions: ["bedrock:InvokeModelWithResponseStream", "bedrock:InvokeModel"],
    resources: [
      `arn:aws:bedrock:eu-west-1:${Stack.of(dataStack).account}:inference-profile/${crossRegionModel}`,
      `arn:aws:bedrock:*::foundation-model/${novaLiteModel}`,
    ],
  })
);

// ─── Voice agent on AgentCore Runtime ────────────────────────────────────
// Deploys the Strands + Nova Sonic voice agent (voice-agent/) as a
// containerized AgentCore Runtime, reusing the Amplify Cognito User Pool
// for authentication.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const voiceStack = backend.createStack("VoiceAgentStack");
const account = Stack.of(voiceStack).account;
const region = Stack.of(voiceStack).region;

// 1. Build the ARM64 container image from voice-agent/ and push it to ECR.
const voiceImage = new ecrAssets.DockerImageAsset(voiceStack, "VoiceAgentImage", {
  directory: path.join(__dirname, "..", "voice-agent"),
  platform: ecrAssets.Platform.LINUX_ARM64,
});

// 2. Execution role for the AgentCore Runtime.
const voiceRuntimeRole = new iam.Role(voiceStack, "VoiceAgentRuntimeRole", {
  assumedBy: new iam.ServicePrincipal("bedrock-agentcore.amazonaws.com", {
    conditions: {
      StringEquals: { "aws:SourceAccount": account },
    },
  }),
});

// Pull the container image from ECR. grantPull covers BatchGetImage and
// GetDownloadUrlForLayer on the repo; GetAuthorizationToken requires "*".
voiceImage.repository.grantPull(voiceRuntimeRole);
voiceRuntimeRole.addToPolicy(
  new iam.PolicyStatement({
    actions: ["ecr:GetAuthorizationToken"],
    resources: ["*"],
  })
);

// Bedrock: Nova Sonic (voice), Nova Micro (query parsing), Titan (embeddings).
voiceRuntimeRole.addToPolicy(
  new iam.PolicyStatement({
    actions: [
      "bedrock:InvokeModel",
      "bedrock:InvokeModelWithResponseStream",
      "bedrock:InvokeModelWithBidirectionalStream",
    ],
    resources: [
      "arn:aws:bedrock:*::foundation-model/amazon.nova-2-sonic-v1:0",
      "arn:aws:bedrock:*::foundation-model/amazon.titan-embed-text-v2:0",
      "arn:aws:bedrock:*::foundation-model/amazon.nova-micro-v1:0",
      `arn:aws:bedrock:*:${account}:inference-profile/eu.amazon.nova-micro-v1:0`,
    ],
  })
);

// DynamoDB: SearchVectors on the products table + vector index.
voiceRuntimeRole.addToPolicy(
  new iam.PolicyStatement({
    actions: ["dynamodb:SearchVectors", "dynamodb:GetItem"],
    resources: [productsTable.tableArn, `${productsTable.tableArn}/index/*`],
  })
);

// CloudWatch logs for the runtime.
voiceRuntimeRole.addToPolicy(
  new iam.PolicyStatement({
    actions: [
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
      "logs:DescribeLogStreams",
    ],
    resources: ["arn:aws:logs:*:*:*"],
  })
);

// 3. Reuse the Amplify Cognito User Pool for inbound JWT authentication.
const userPool = backend.auth.resources.userPool;
const userPoolClient = backend.auth.resources.userPoolClient;
const discoveryUrl = `https://cognito-idp.${region}.amazonaws.com/${userPool.userPoolId}/.well-known/openid-configuration`;

// 4. The AgentCore Runtime itself (L1 CfnRuntime).
const voiceRuntime = new CfnRuntime(voiceStack, "VoiceAgentRuntime", {
  agentRuntimeName: "voiceShoppingAgent",
  agentRuntimeArtifact: {
    containerConfiguration: {
      containerUri: voiceImage.imageUri,
    },
  },
  networkConfiguration: { networkMode: "PUBLIC" },
  // AgentCore bidirectional streaming (WebSocket) runs over the HTTP server
  // protocol; the container exposes /ws. Valid values: HTTP, A2A, AGUI, MCP.
  protocolConfiguration: "HTTP",
  roleArn: voiceRuntimeRole.roleArn,
  environmentVariables: {
    CONTAINER_ENV: "true",
    TABLE_NAME: productsTable.tableName,
    TABLE_REGION: region,
    BEDROCK_REGION: "eu-north-1",
    EMBEDDING_MODEL_ID: "amazon.titan-embed-text-v2:0",
    LLM_MODEL_ID: "eu.amazon.nova-micro-v1:0",
  },
  authorizerConfiguration: {
    customJwtAuthorizer: {
      discoveryUrl,
      allowedClients: [userPoolClient.userPoolClientId],
    },
  },
});

// 5. Allow the signed-in user (authenticated Identity Pool role) to open the
// SigV4-signed WebSocket to the runtime. The request is signed with the user's
// temporary credentials, so the authenticated role needs InvokeAgentRuntime.
// We attach this as a standalone policy defined INSIDE the voice stack (which
// already depends on auth). Modifying the auth role's inline policy directly
// would make the auth stack depend on the voice stack and create a cycle.
new iam.Policy(voiceStack, "VoiceAgentInvokePolicy", {
  roles: [backend.auth.resources.authenticatedUserIamRole],
  statements: [
    new iam.PolicyStatement({
      actions: [
        "bedrock-agentcore:InvokeAgentRuntime",
        "bedrock-agentcore:InvokeAgentRuntimeForUser",
        "bedrock-agentcore:InvokeAgentRuntimeWithWebSocketStream",
      ],
      resources: [
        voiceRuntime.attrAgentRuntimeArn,
        `${voiceRuntime.attrAgentRuntimeArn}/*`,
      ],
    }),
  ],
});

// 6. Export the runtime ARN + region so the frontend can build the
// SigV4-signed WebSocket URL.
backend.addOutput({
  custom: {
    VoiceAgentRuntimeArn: voiceRuntime.attrAgentRuntimeArn,
    VoiceAgentRegion: region,
  },
});
