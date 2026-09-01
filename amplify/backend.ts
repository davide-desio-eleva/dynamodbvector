import { defineBackend } from "@aws-amplify/backend";
import { auth } from "./auth/resource";
import { data, searchProductsHandler, chatHandler, crossRegionModel, novaLiteModel } from "./data/resource";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as cr from "aws-cdk-lib/custom-resources";
import { Stack } from "aws-cdk-lib";

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
