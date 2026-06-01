#!/usr/bin/env node
/**
 * Semantic Layer CDK Application
 *
 * Deploys complete infrastructure for insurance semantic layer including:
 * - Cognito authentication and authorization
 * - DynamoDB for operational data
 * - S3 data lake for historical data
 * - AWS Glue for metadata catalog
 * - Amazon Neptune for knowledge graph
 * - Amazon Bedrock Knowledge Base for ontology patterns
 * - Amazon Athena for federated queries
 * - Lambda REST API for semantic layer operations
 * - Bedrock AgentCore Runtime with Strands agents
 * - React frontend with CloudFront
 */

import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { Aspects } from 'aws-cdk-lib';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';
import { NetworkingStack } from '../lib/stacks/backend/networking-stack';
import { DynamoDBStack } from '../lib/stacks/backend/dynamodb-stack';
import { DataLakeStack } from '../lib/stacks/backend/data-lake-stack';
import { GlueCatalogStack } from '../lib/stacks/backend/glue-catalog-stack';
import { NeptuneStack } from '../lib/stacks/backend/neptune-stack';
import { BedrockKnowledgeBaseStack } from '../lib/stacks/backend/bedrock-kb-stack';
import { AthenaStack } from '../lib/stacks/backend/athena-stack';
import { AgentCoreStack } from '../lib/stacks/backend/agentcore-stack';
import { FrontendStack } from '../lib/stacks/frontend';
import { CloudFrontStorageStack } from '../lib/stacks/frontend/cloudfront-storage';
import { AuthStack } from '../lib/stacks/backend/auth';
import { LambdaRestApiStack } from '../lib/stacks/backend/lambda-rest-api';
import { GuardrailsStack } from '../lib/stacks/backend/guardrails';
import { ZeroEtlStack } from '../lib/stacks/backend/zeroetl';
import { NormalizedViewsStack } from '../lib/stacks/backend/normalized-views-stack';

const app = new cdk.App();

// Environment configuration
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
};

const projectName = 'semantic-layer';

// Human/SSO roles that must retain LF admin status across all CDK redeploys.
// Passed to every stack that owns a CfnDataLakeSettings so none are silently dropped.
// Add any IAM role ARN that needs to browse s3tablescatalog in the Glue/Athena console.
const additionalLakeFormationAdmins = [
  `arn:aws:iam::${process.env.CDK_DEFAULT_ACCOUNT}:role/Admin`,
];

// Optional deployment suffix — allows multiple independent deployments in the same account/region.
// Usage: cdk deploy --context suffix=v2
// Stack names become: semantic-layer-v2-networking, semantic-layer-v2-dynamodb, etc.
// Resource names inside stacks are also suffixed so there are no name conflicts.
// When omitted the behaviour is identical to the previous default (no suffix).
const suffix = (app.node.tryGetContext('suffix') as string | undefined) ?? 'dev';
const deployName = `${projectName}-${suffix}`;

// VKG-only customer build: VKG agents always on, batch Zero-ETL replication only.
// 1. Networking Stack - VPC for Neptune and private resources
const networkingStack = new NetworkingStack(app, `${deployName}-networking`, {
  env,
  description: 'VPC and networking infrastructure for semantic layer',
  projectName: deployName,
});

// 2. DynamoDB Stack - Operational data storage
const dynamodbStack = new DynamoDBStack(app, `${deployName}-dynamodb`, {
  env,
  description: 'DynamoDB tables for insurance operational data',
  projectName: deployName,
});

// 3. Glue Catalog Stack - Schema discovery and Iceberg database
const glueCatalogStack = new GlueCatalogStack(app, `${deployName}-glue-catalog`, {
  env,
  description: 'AWS Glue Data Catalog for DynamoDB schema discovery and S3 Tables (Iceberg)',
  projectName: deployName,
  dynamodbStack,
  autoStartCrawlers: true, // Auto-start DynamoDB crawler on deployment
});

// 4. Data Lake Stack - S3 Tables (Iceberg) for analytics
const dataLakeStack = new DataLakeStack(app, `${deployName}-data-lake`, {
  env,
  description: 'S3 Tables data lake for analytics fed by Glue Zero-ETL',
  projectName: deployName,
  glueCatalogStack,
});

// 5. Zero-ETL Stack — DynamoDB → S3 Tables batch replication
const zeroEtlStack = new ZeroEtlStack(app, `${deployName}-zeroetl`, {
  env,
  description: 'Glue Zero-ETL integrations from DynamoDB tables to S3 Tables',
  projectName: deployName,
  dynamodbStack,
  tableBucketArn: dataLakeStack.tableBucketArn,
  tableBucketName: dataLakeStack.tableBucketName,
  tableBucketNamespace: dataLakeStack.namespace,
});

// 6. Normalized Views Stack — 40 Glue materialized views in 'normalized' S3 Tables namespace
const normalizedViewsStack = new NormalizedViewsStack(app, `${deployName}-normalized-views`, {
  env,
  description: 'Glue materialized views normalizing Zero-ETL S3 Tables into entity tables',
  projectName: deployName,
  dataLakeStack,
  zeroEtlStack,
  refreshIntervalHours: 6,
  additionalLakeFormationAdmins,
});

// 7. Neptune Stack - Knowledge graph for semantic ontology (VKG)
const neptuneStack = new NeptuneStack(app, `${deployName}-neptune`, {
  env,
  description: 'Amazon Neptune RDF graph database for ontology',
  projectName: deployName,
  vpc: networkingStack.vpc,
});

// 8. Bedrock Knowledge Base Stack — ontology-patterns KB consumed by the ontology generation agent
const bedrockKbStack = new BedrockKnowledgeBaseStack(app, `${deployName}-bedrock-kb`, {
  env,
  description: 'Amazon Bedrock Knowledge Base for ontology patterns',
  projectName: deployName,
  artifactsBucket: dataLakeStack.artifactsBucket,
  autoStartIngestion: true,
});

// 9. Athena Stack - Federated query engine
const athenaStack = new AthenaStack(app, `${deployName}-athena`, {
  env,
  description: 'Amazon Athena federated query infrastructure',
  projectName: deployName,
  dataLakeStack,
  glueCatalogStack,
  dynamodbStack,
  vpc: networkingStack.vpc,
  additionalLakeFormationAdmins,
});

// 11. AgentCore Stack - Strands agents (ontology + ontology-query) on Bedrock AgentCore Runtime
const agentcoreStack = new AgentCoreStack(app, `${deployName}-agentcore`, {
  env,
  description: 'Bedrock AgentCore Runtime with Strands agents',
  projectName: deployName,
  vpc: networkingStack.vpc,
  neptuneStack,
  bedrockKbStack,
  glueCatalogStack,
  dynamodbStack,
  athenaStack,
  dataLakeStack,
  additionalLakeFormationAdmins,
});

// 12. CloudFront Storage Stack - Create CloudFront distribution and S3 bucket FIRST
// This allows the CloudFront URL to be used in Cognito callback URLs
const cloudfrontStorageStack = new CloudFrontStorageStack(app, `${deployName}-cloudfront-storage`, {
  env,
  description: 'CloudFront distribution and S3 storage for frontend',
  projectName: deployName,
  loggingBucket: dataLakeStack.loggingBucket,
});

// 14. Auth Stack - Cognito authentication and authorization
// Now receives CloudFront URL from cloudfrontStorageStack.urls
const authStack = new AuthStack(app, `${deployName}-auth`, {
  env,
  description: 'Cognito authentication and authorization for semantic layer',
  urls: cloudfrontStorageStack.urls,
});

// 15. Guardrails Stack - Bedrock Guardrails for AI safety
const guardrailsStack = new GuardrailsStack(app, `${deployName}-guardrails`, {
  env,
  description: 'Bedrock Guardrails for semantic layer AI protection',
});

// 16. Lambda REST API Stack - Serverless API for semantic layer operations
// Lambda handles REST API endpoints and delegates to AgentCore Runtime for data operations
const lambdaApiStack = new LambdaRestApiStack(app, `${deployName}-lambda-api`, {
  env,
  region: env.region!,
  stage: 'dev',
  projectId: deployName,
  userPool: authStack.userPool,
  userPoolClient: authStack.userPoolClient,
  identityPoolId: authStack.identityPool.identityPoolId,
  // S3 buckets
  artifactsBucket: dataLakeStack.artifactsBucket,
  // Ontology metadata table
  ontologyMetadataTable: dynamodbStack.metadataTable,
  // AgentCore Runtime ARNs (VKG only)
  ontologyRuntimeArn: agentcoreStack.ontologyRuntimeArn,
  queryRuntimeArn: agentcoreStack.queryRuntimeArn,
  // AgentCore Gateway configuration for Neptune access (IAM authenticated)
  neptuneGatewayUrl: agentcoreStack.neptuneGateway?.gatewayUrl,
  neptuneGatewayArn: agentcoreStack.neptuneGateway?.gatewayArn,
  // Data Lake configuration for Lake Formation permissions
  glueNamespaceDynamoDB: glueCatalogStack.dynamodbDatabase.ref,
  // Lake Formation admin chain — carry forward all prior LF admins so this stack's
  // CfnDataLakeSettings (last writer wins) preserves existing grants while adding the Lambda role
  lfGrantSingletonRoleArn: dataLakeStack.lfGrantSingletonRoleArn,
  additionalLakeFormationAdmins,
  // Bedrock Guardrails
  guardrailId: guardrailsStack.guardrailId,
  guardrailVersion: guardrailsStack.guardrailVersion,
  // Explicit CORS allowed origins — CloudFront domain + localhost for dev
  allowedOrigins: [
    `https://${cloudfrontStorageStack.distribution.distributionDomainName}`,
    'http://localhost:3000',
    'http://localhost:5173',
  ],
  // Regional WAF WebACL for API Gateway protection
  regionalWebAclArn: authStack.regionalWebAclArn,
});

// 17. Frontend Stack - React app build and deployment
// Uses existing CloudFront distribution and S3 bucket from CloudFrontStorageStack
const frontendStack = new FrontendStack(app, `${deployName}-frontend`, {
  env,
  description: 'Frontend React application build and deployment',
  apiUrl: lambdaApiStack.httpApi.apiEndpoint,
  userPoolId: authStack.userPool.userPoolId,
  userPoolClientId: authStack.userPoolClient.userPoolClientId,
  userPoolDomain: authStack.userPoolDomain?.domainName,
  projectName: deployName,
  apiGatewayEndpoint: lambdaApiStack.httpApi.apiEndpoint,
  cloudFrontHeaderSecret: lambdaApiStack.cloudFrontHeaderSecret,
  distribution: cloudfrontStorageStack.distribution,
  websiteBucket: cloudfrontStorageStack.websiteBucket,
});

// Stack dependencies
zeroEtlStack.addDependency(dynamodbStack);
zeroEtlStack.addDependency(dataLakeStack);
normalizedViewsStack.addDependency(zeroEtlStack);
normalizedViewsStack.addDependency(dataLakeStack);
glueCatalogStack.addDependency(dynamodbStack);
// Note: GlueCatalogStack creates the Iceberg database first
// dataLakeStack depends on it (uses the database name)
dataLakeStack.addDependency(glueCatalogStack);
neptuneStack.addDependency(networkingStack);
agentcoreStack.addDependency(neptuneStack);
bedrockKbStack.addDependency(dataLakeStack);
agentcoreStack.addDependency(bedrockKbStack);
athenaStack.addDependency(dataLakeStack);
athenaStack.addDependency(glueCatalogStack);
athenaStack.addDependency(dynamodbStack);
athenaStack.addDependency(networkingStack);
agentcoreStack.addDependency(glueCatalogStack);
agentcoreStack.addDependency(athenaStack);
cloudfrontStorageStack.addDependency(dataLakeStack); // Needs logging bucket
authStack.addDependency(cloudfrontStorageStack); // Needs CloudFront URL for callback URLs
lambdaApiStack.addDependency(authStack); // Needs Cognito configuration
lambdaApiStack.addDependency(dataLakeStack); // Needs artifacts bucket
lambdaApiStack.addDependency(dynamodbStack); // Needs ontology metadata table
lambdaApiStack.addDependency(agentcoreStack); // Needs AgentCore Runtime ARNs
lambdaApiStack.addDependency(guardrailsStack); // Needs guardrail ID and version
frontendStack.addDependency(cloudfrontStorageStack); // Uses existing distribution and bucket
frontendStack.addDependency(authStack);
frontendStack.addDependency(lambdaApiStack);
// CloudFront integration is part of FrontendStack

// Global tags
cdk.Tags.of(app).add('Project', deployName);
cdk.Tags.of(app).add('Environment', 'development');
cdk.Tags.of(app).add('ManagedBy', 'CDK');

// Apply cdk-nag security checks to all stacks
Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));

// Suppress known false positives and CDK-managed construct violations
// These suppressions are intentional architectural decisions documented per rule
const suppressions = [
  {
    id: 'AwsSolutions-L1',
    reason:
      'System-generated Lambda functions (custom resource handlers, log retention, CodeBuild custom resource handlers) are created by CDK constructs and use Node.js 14.x as designed by the framework. These are framework internals, not application code.',
  },
  {
    id: 'AwsSolutions-IAM4',
    reason:
      'AWSLambdaBasicExecutionRole is required minimum for Lambda logging to CloudWatch Logs. This is the standard AWS managed policy for Lambda execution and cannot be replaced with a more restrictive custom policy without breaking core functionality.',
    appliesTo: [
      'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
    ],
  },
  {
    id: 'AwsSolutions-IAM5',
    reason:
      'Wildcard permissions in CodeBuild and Lambda custom resource roles are generated by CDK constructs (e.g., S3 asset bucket access, log group patterns). These are CDK-managed and follow least privilege for their respective scopes.',
  },
];

// Apply suppressions to all stacks
[
  networkingStack,
  dynamodbStack,
  glueCatalogStack,
  dataLakeStack,
  zeroEtlStack,
  normalizedViewsStack,
  neptuneStack,
  bedrockKbStack,
  athenaStack,
  agentcoreStack,
  cloudfrontStorageStack,
  authStack,
  guardrailsStack,
  lambdaApiStack,
  frontendStack,
].forEach((stack) => {
  NagSuppressions.addStackSuppressions(stack, suppressions);
});

app.synth();
