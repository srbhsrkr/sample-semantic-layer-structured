import * as cdk from 'aws-cdk-lib';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as lakeformation from 'aws-cdk-lib/aws-lakeformation';
import * as agentcore from '@aws-cdk/aws-bedrock-agentcore-alpha';
import { Construct } from 'constructs';
import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { ArmBuildConstruct } from '../../common/constructs/arm-build-construct';
import { AgentCoreNeptuneGateway } from './agentcore/neptune-gateway-construct';
import { NeptuneStack } from './neptune-stack';
import { BedrockKnowledgeBaseStack } from './bedrock-kb-stack';
import { GlueCatalogStack } from './glue-catalog-stack';
import { DynamoDBStack } from './dynamodb-stack';
import { AthenaStack } from './athena-stack';
import { DataLakeStack } from './data-lake-stack';

export interface AgentCoreStackProps extends cdk.StackProps {
  projectName: string;
  vpc: ec2.Vpc;
  neptuneStack: NeptuneStack;
  bedrockKbStack: BedrockKnowledgeBaseStack;
  glueCatalogStack: GlueCatalogStack;
  dynamodbStack: DynamoDBStack;
  athenaStack: AthenaStack;
  dataLakeStack: DataLakeStack;
  /** Human/SSO role ARNs that must retain LF admin status across CDK redeploys.
   *  Carried forward into AgentCoreLFAdminSettings (last-writer-wins). */
  additionalLakeFormationAdmins?: string[];
}

/**
 * AgentCore Stack
 *
 * Deploys the two VKG Strands agents on Bedrock AgentCore Runtime:
 *   - Ontology Generation Agent  → builds OWL ontologies, writes to Neptune
 *   - Ontology Query Agent       → translates NL → SPARQL → Athena SQL
 *
 * Provides:
 *   - 2 IAM roles (one per agent)
 *   - 1 shared ECR repository
 *   - 2 ARM64 Docker builds (one per agent)
 *   - 1 AgentCore Neptune Gateway (HTTP gateway → Neptune SPARQL)
 *   - Per-runtime OTEL log groups + USAGE_LOGS deliveries
 *   - Lake Formation grants for Glue + S3 Tables federated catalog
 */
export class AgentCoreStack extends cdk.Stack {
  public readonly ontologyAgentRole: iam.Role;
  public readonly queryAgentRole: iam.Role;
  public readonly agentRepository: ecr.Repository;
  public readonly ontologyRuntime: agentcore.Runtime;
  public readonly ontologyRuntimeArn: string;
  public readonly queryRuntime: agentcore.Runtime;
  public readonly queryRuntimeArn: string;
  public readonly neptuneGateway: AgentCoreNeptuneGateway;

  constructor(scope: Construct, id: string, props: AgentCoreStackProps) {
    super(scope, id, props);

    // Shared catalog ID for S3 Tables Iceberg federated catalog — used by all LF grants
    const icebergCatalogId = `${this.account}:s3tablescatalog/${props.dataLakeStack.tableBucketName}`;

    // ECR repository for agent container images
    this.agentRepository = new ecr.Repository(this, 'AgentRepository', {
      repositoryName: `${props.projectName}-agents`,
      imageScanOnPush: true,
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
      lifecycleRules: [
        {
          maxImageCount: 10,
          description: 'Keep last 10 images',
        },
      ],
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      emptyOnDelete: true,
    });

    // Shared security group for all AgentCore Runtime containers.
    const agentcoreSecurityGroup = new ec2.SecurityGroup(this, 'AgentCoreRuntimeSecurityGroup', {
      vpc: props.vpc,
      description: 'Security group for all AgentCore Runtime containers',
      allowAllOutbound: true,
    });

    // Shared VPC network configuration — places every Runtime container in the private
    // (PRIVATE_WITH_EGRESS) subnets so it reaches VPC endpoints without a public IP.
    const agentcoreNetworkConfig = agentcore.RuntimeNetworkConfiguration.usingVpc(this, {
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [agentcoreSecurityGroup],
    });

    // ============================================================
    // IAM role for Ontology Generation Agent
    // ============================================================
    this.ontologyAgentRole = new iam.Role(this, 'OntologyGenerationAgentRole', {
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
      description: 'Role for ontology generation agent',
    });

    this.ontologyAgentRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'glue:GetDatabase',
          'glue:GetDatabases',
          'glue:GetTable',
          'glue:GetTables',
          'glue:UpdateTable',
        ],
        resources: [
          `arn:aws:glue:${this.region}:${this.account}:catalog`,
          `arn:aws:glue:${this.region}:${this.account}:database/*`,
          `arn:aws:glue:${this.region}:${this.account}:table/*/*`,
          `arn:aws:glue:${this.region}:${this.account}:catalog/s3tablescatalog`,
          `arn:aws:glue:${this.region}:${this.account}:catalog/s3tablescatalog/*`,
          `arn:aws:glue:${this.region}:${this.account}:database/s3tablescatalog/*/*`,
          `arn:aws:glue:${this.region}:${this.account}:table/s3tablescatalog/*/*/*`,
          `arn:aws:glue:${this.region}:${this.account}:catalog/dynamodb_catalog`,
          `arn:aws:glue:${this.region}:${this.account}:database/dynamodb_catalog/*`,
          `arn:aws:glue:${this.region}:${this.account}:table/dynamodb_catalog/*/*`,
        ],
      })
    );

    this.ontologyAgentRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['athena:GetDataCatalog', 'athena:ListDataCatalogs'],
        resources: [
          `arn:aws:athena:${this.region}:${this.account}:datacatalog/*`,
        ],
      })
    );

    this.ontologyAgentRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          's3tables:GetTable',
          's3tables:GetTableMetadata',
          's3tables:GetTableMetadataLocation',
          's3tables:GetTableData',
          's3tables:GetTableBucket',
          's3tables:GetNamespace',
          's3tables:ListTables',
          's3tables:ListNamespaces',
          's3tables:UpdateTableMetadataLocation',
          's3tables:PutTableData',
        ],
        resources: [`arn:aws:s3tables:${this.region}:${this.account}:bucket/*`],
      })
    );

    this.ontologyAgentRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['dynamodb:Scan', 'dynamodb:DescribeTable'],
        resources: [
          `arn:aws:dynamodb:${this.region}:${this.account}:table/${props.projectName}-*`,
        ],
      })
    );

    this.ontologyAgentRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'athena:StartQueryExecution',
          'athena:GetQueryExecution',
          'athena:GetQueryResults',
          'athena:StopQueryExecution',
        ],
        resources: [
          `arn:aws:athena:${this.region}:${this.account}:workgroup/${props.athenaStack.workgroup.name}`,
        ],
      })
    );

    props.dataLakeStack.athenaResultsBucket.grantReadWrite(this.ontologyAgentRole);

    this.ontologyAgentRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['bedrock:Retrieve', 'bedrock:RetrieveAndGenerate'],
        resources: [
          `arn:aws:bedrock:${this.region}:${this.account}:knowledge-base/${props.bedrockKbStack.ontologyPatternsKbId}`,
        ],
      })
    );

    this.ontologyAgentRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: [
          `arn:aws:bedrock:${this.region}::foundation-model/anthropic.claude-opus-4-6-*`,
          `arn:aws:bedrock:${this.region}::foundation-model/anthropic.*`,
          `arn:aws:bedrock:::foundation-model/anthropic.claude-opus-4-6-*`,
          `arn:aws:bedrock:::foundation-model/anthropic.*`,
          `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/global.anthropic.claude-opus-4-6-*`,
          `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/global.*`,
        ],
      })
    );

    this.ontologyAgentRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'ecr:BatchGetImage',
          'ecr:GetDownloadUrlForLayer',
          'ecr:BatchCheckLayerAvailability',
        ],
        resources: ['*'],
      })
    );

    this.ontologyAgentRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['ecr:GetAuthorizationToken'],
        resources: ['*'],
      })
    );

    this.ontologyAgentRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [
          `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/bedrock-agentcore/runtimes/*`,
          `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/bedrock-agentcore/runtimes/*:*`,
        ],
      })
    );

    this.ontologyAgentRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'bedrock-agentcore:GetWorkloadAccessToken',
          'bedrock-agentcore:GetWorkloadAccessTokenForJWT',
        ],
        resources: [
          `arn:aws:bedrock-agentcore:${this.region}:${this.account}:workload-identity-directory/default/*`,
        ],
      })
    );

    this.ontologyAgentRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['lakeformation:GetDataAccess'],
        resources: ['*'],
      })
    );

    this.ontologyAgentRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'ec2:CreateNetworkInterface',
          'ec2:DescribeNetworkInterfaces',
          'ec2:DeleteNetworkInterface',
          'ec2:AssignPrivateIpAddresses',
          'ec2:UnassignPrivateIpAddresses',
        ],
        resources: ['*'],
      })
    );

    props.dataLakeStack.artifactsBucket.grantReadWrite(this.ontologyAgentRole);
    props.dynamodbStack.metadataTable.grantReadWriteData(this.ontologyAgentRole);

    new lakeformation.CfnPermissions(this, 'OntologyLFDynamoDBDatabasePermissions', {
      dataLakePrincipal: { dataLakePrincipalIdentifier: this.ontologyAgentRole.roleArn },
      resource: { databaseResource: { name: props.glueCatalogStack.dynamodbDatabase.ref } },
      permissions: ['DESCRIBE', 'ALTER'],
    });

    new lakeformation.CfnPermissions(this, 'OntologyLFDynamoDBTablePermissions', {
      dataLakePrincipal: { dataLakePrincipalIdentifier: this.ontologyAgentRole.roleArn },
      resource: {
        tableResource: {
          databaseName: props.glueCatalogStack.dynamodbDatabase.ref,
          tableWildcard: {},
        },
      },
      permissions: ['SELECT', 'DESCRIBE', 'ALTER'],
    });

    // ============================================================
    // IAM role for Ontology Query Agent
    // ============================================================
    this.queryAgentRole = new iam.Role(this, 'SemanticQueryAgentRole', {
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
      description: 'Role for ontology query agent',
    });

    props.dynamodbStack.metadataTable.grantReadData(this.queryAgentRole);

    // Allow the query agent to write step labels (current_step) back to the
    // query-results row owned by the lambda-api stack. Scoped to UpdateItem
    // only — the agent never reads, creates, or deletes rows. Table ARN is
    // built by string interpolation (instead of importing the table) to avoid
    // a CloudFormation cyclic dependency between agentcore and lambda-api.
    this.queryAgentRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['dynamodb:UpdateItem'],
        resources: [
          `arn:aws:dynamodb:${this.region}:${this.account}:table/${props.projectName}-query-results`,
        ],
      })
    );

    this.queryAgentRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'athena:StartQueryExecution',
          'athena:GetQueryExecution',
          'athena:GetQueryResults',
          'athena:StopQueryExecution',
        ],
        resources: [
          `arn:aws:athena:${this.region}:${this.account}:workgroup/${props.athenaStack.workgroup.name}`,
        ],
      })
    );

    this.queryAgentRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'glue:GetCatalog',
          'glue:GetDatabase',
          'glue:GetDatabases',
          'glue:GetTable',
          'glue:GetTables',
          'glue:GetPartitions',
        ],
        resources: [
          `arn:aws:glue:${this.region}:${this.account}:catalog`,
          `arn:aws:glue:${this.region}:${this.account}:database/*`,
          `arn:aws:glue:${this.region}:${this.account}:table/*`,
          `arn:aws:glue:${this.region}:${this.account}:catalog/s3tablescatalog`,
          `arn:aws:glue:${this.region}:${this.account}:catalog/s3tablescatalog/*`,
          `arn:aws:glue:${this.region}:${this.account}:database/s3tablescatalog/*/*`,
          `arn:aws:glue:${this.region}:${this.account}:table/s3tablescatalog/*/*/*`,
          `arn:aws:glue:${this.region}:${this.account}:catalog/dynamodb_catalog`,
          `arn:aws:glue:${this.region}:${this.account}:database/dynamodb_catalog/*`,
          `arn:aws:glue:${this.region}:${this.account}:table/dynamodb_catalog/*/*`,
        ],
      })
    );

    this.queryAgentRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['athena:GetDataCatalog', 'athena:ListDataCatalogs'],
        resources: [
          `arn:aws:athena:${this.region}:${this.account}:datacatalog/*`,
        ],
      })
    );

    props.dataLakeStack.athenaResultsBucket.grantReadWrite(this.queryAgentRole);

    this.queryAgentRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          's3tables:GetTable',
          's3tables:GetTableMetadata',
          's3tables:GetNamespace',
          's3tables:ListNamespaces',
          's3tables:ListTables',
          's3tables:GetTableData',
        ],
        resources: [
          props.dataLakeStack.tableBucketArn,
          `${props.dataLakeStack.tableBucketArn}/*`,
        ],
      })
    );

    this.queryAgentRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: [
          `arn:aws:bedrock:${this.region}::foundation-model/anthropic.claude-opus-4-6-*`,
          `arn:aws:bedrock:${this.region}::foundation-model/anthropic.claude-sonnet-4-6*`,
          `arn:aws:bedrock:::foundation-model/anthropic.claude-opus-4-6-*`,
          `arn:aws:bedrock:::foundation-model/anthropic.claude-sonnet-4-6*`,
          `arn:aws:bedrock:::foundation-model/anthropic.*`,
          `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/global.anthropic.claude-opus-4-6-*`,
          `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/global.anthropic.claude-sonnet-4-6*`,
          `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/global.anthropic.*`,
        ],
      })
    );

    this.queryAgentRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'ecr:BatchGetImage',
          'ecr:GetDownloadUrlForLayer',
          'ecr:BatchCheckLayerAvailability',
        ],
        resources: ['*'],
      })
    );

    this.queryAgentRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['ecr:GetAuthorizationToken'],
        resources: ['*'],
      })
    );

    this.queryAgentRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [
          `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/bedrock-agentcore/runtimes/*`,
          `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/bedrock-agentcore/runtimes/*:*`,
        ],
      })
    );

    this.queryAgentRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'bedrock-agentcore:GetWorkloadAccessToken',
          'bedrock-agentcore:GetWorkloadAccessTokenForJWT',
        ],
        resources: [
          `arn:aws:bedrock-agentcore:${this.region}:${this.account}:workload-identity-directory/default/*`,
        ],
      })
    );

    this.queryAgentRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['lakeformation:GetDataAccess'],
        resources: ['*'],
      })
    );

    this.queryAgentRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'ec2:CreateNetworkInterface',
          'ec2:DescribeNetworkInterfaces',
          'ec2:DeleteNetworkInterface',
          'ec2:AssignPrivateIpAddresses',
          'ec2:UnassignPrivateIpAddresses',
        ],
        resources: ['*'],
      })
    );

    this.queryAgentRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['ssm:GetParameter', 'ssm:GetParameters'],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter/${props.projectName}/athena/query-results-bucket`,
        ],
      })
    );

    // Athena routes dynamodb_catalog queries through the DDB connector Lambda;
    // the agent role must be able to invoke it. The connector spills oversize
    // result fragments to S3 with KMS encryption, and the caller (agent role)
    // reads them back — so it also needs S3 + KMS Decrypt on the spill bucket.
    this.queryAgentRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['lambda:InvokeFunction'],
        resources: [
          `arn:aws:lambda:${this.region}:${this.account}:function:${props.projectName}-ddb-connector`,
        ],
      })
    );
    props.athenaStack.spillBucket.grantReadWrite(this.queryAgentRole);
    props.athenaStack.spillEncryptionKey.grantEncryptDecrypt(this.queryAgentRole);

    new lakeformation.CfnPermissions(this, 'QueryLFDynamoDBDatabasePermissions', {
      dataLakePrincipal: { dataLakePrincipalIdentifier: this.queryAgentRole.roleArn },
      resource: { databaseResource: { name: props.glueCatalogStack.dynamodbDatabase.ref } },
      permissions: ['DESCRIBE'],
    });

    new lakeformation.CfnPermissions(this, 'QueryLFDynamoDBTablePermissions', {
      dataLakePrincipal: { dataLakePrincipalIdentifier: this.queryAgentRole.roleArn },
      resource: {
        tableResource: {
          databaseName: props.glueCatalogStack.dynamodbDatabase.ref,
          tableWildcard: {},
        },
      },
      permissions: ['SELECT', 'DESCRIBE'],
    });

    // ── normalized namespace grants ─────────────────────────────────────────────
    // Zero-ETL + NormalizedViewsStack are always deployed in this customer build,
    // so agent roles always need LF SELECT on the 'normalized' S3 Tables namespace.
    // LF hides tables without SELECT as TABLE_OR_VIEW_NOT_FOUND (not ACCESS_DENIED).
    const tableBucketArn = `arn:aws:s3tables:${this.region}:${this.account}:bucket/${props.dataLakeStack.tableBucketName}`;

    // Pre-create 'normalized' namespace — idempotent with NormalizedViewsStack's own CR.
    const ensureNormalizedNs = new cr.AwsCustomResource(this, 'EnsureNormalizedNamespace', {
      onCreate: {
        service: 'S3Tables',
        action: 'createNamespace',
        parameters: { tableBucketARN: tableBucketArn, namespace: ['normalized'] },
        physicalResourceId: cr.PhysicalResourceId.of('agentcore-normalized-namespace'),
        ignoreErrorCodesMatching: 'ConflictException',
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['s3tables:CreateNamespace', 's3tables:GetNamespace'],
          resources: [tableBucketArn],
        }),
      ]),
    });

    const lfNormalizedDbQuery = new lakeformation.CfnPermissions(
      this,
      'QueryLFNormalizedDbPermissions',
      {
        dataLakePrincipal: { dataLakePrincipalIdentifier: this.queryAgentRole.roleArn },
        resource: { databaseResource: { catalogId: icebergCatalogId, name: 'normalized' } },
        permissions: ['DESCRIBE'],
      }
    );
    lfNormalizedDbQuery.node.addDependency(ensureNormalizedNs);

    const lfNormalizedTablesQuery = new lakeformation.CfnPermissions(
      this,
      'QueryLFNormalizedTablePermissions',
      {
        dataLakePrincipal: { dataLakePrincipalIdentifier: this.queryAgentRole.roleArn },
        resource: {
          tableResource: {
            catalogId: icebergCatalogId,
            databaseName: 'normalized',
            tableWildcard: {},
          },
        },
        permissions: ['SELECT', 'DESCRIBE'],
      }
    );
    lfNormalizedTablesQuery.node.addDependency(ensureNormalizedNs);

    const lfNormalizedDbOntology = new lakeformation.CfnPermissions(
      this,
      'OntologyLFNormalizedDbPermissions',
      {
        dataLakePrincipal: { dataLakePrincipalIdentifier: this.ontologyAgentRole.roleArn },
        resource: { databaseResource: { catalogId: icebergCatalogId, name: 'normalized' } },
        permissions: ['DESCRIBE', 'ALTER'],
      }
    );
    lfNormalizedDbOntology.node.addDependency(ensureNormalizedNs);

    const lfNormalizedTablesOntology = new lakeformation.CfnPermissions(
      this,
      'OntologyLFNormalizedTablePermissions',
      {
        dataLakePrincipal: { dataLakePrincipalIdentifier: this.ontologyAgentRole.roleArn },
        resource: {
          tableResource: {
            catalogId: icebergCatalogId,
            databaseName: 'normalized',
            tableWildcard: {},
          },
        },
        permissions: ['SELECT', 'DESCRIBE', 'ALTER'],
      }
    );
    lfNormalizedTablesOntology.node.addDependency(ensureNormalizedNs);

    // ============================================================
    // Lake Formation: preserve infrastructure admins
    // (last writer wins per account/region — supersedes AthenaStack settings)
    // ============================================================
    new lakeformation.CfnDataLakeSettings(this, 'AgentCoreLFAdminSettings', {
      admins: [
        {
          dataLakePrincipalIdentifier: `arn:aws:iam::${this.account}:role/cdk-hnb659fds-cfn-exec-role-${this.account}-${this.region}`,
        },
        {
          dataLakePrincipalIdentifier: `arn:aws:iam::${this.account}:role/cdk-hnb659fds-deploy-role-${this.account}-${this.region}`,
        },
        { dataLakePrincipalIdentifier: props.dataLakeStack.lfGrantSingletonRoleArn },
        ...(props.additionalLakeFormationAdmins ?? []).map((arn) => ({
          dataLakePrincipalIdentifier: arn,
        })),
      ],
    });

    // ============================================================
    // ECR pulls + ARM64 Docker builds
    // ============================================================
    this.agentRepository.grantPull(this.ontologyAgentRole);
    this.agentRepository.grantPull(this.queryAgentRole);

    const ontologyBuild = new ArmBuildConstruct(this, 'OntologyAgentBuild', {
      sourcePath: '../agents',
      region: this.region,
      namePrefix: `${props.projectName}-ontology`,
      buildTimeoutMinutes: 20,
      dockerfileName: 'Dockerfile.ontology',
    });

    const queryBuild = new ArmBuildConstruct(this, 'OntologyQueryAgentBuild', {
      sourcePath: '../agents',
      region: this.region,
      namePrefix: `${props.projectName}-ontology-query`,
      buildTimeoutMinutes: 20,
      dockerfileName: 'Dockerfile.ontologyquery',
    });

    const ontologyArtifact = agentcore.AgentRuntimeArtifact.fromEcrRepository(
      ontologyBuild.repository,
      ontologyBuild.imageTag
    );

    const queryArtifact = agentcore.AgentRuntimeArtifact.fromEcrRepository(
      queryBuild.repository,
      queryBuild.imageTag
    );

    ontologyBuild.repository.grantPull(this.ontologyAgentRole);
    queryBuild.repository.grantPull(this.queryAgentRole);

    // ============================================================
    // Neptune Gateway — created BEFORE runtimes
    // ============================================================
    this.neptuneGateway = new AgentCoreNeptuneGateway(this, 'NeptuneGateway', {
      projectName: props.projectName,
      neptuneCluster: props.neptuneStack.cluster,
      neptuneSecurityGroup: props.neptuneStack.securityGroup,
      neptuneConnectionSecret: props.neptuneStack.connectionSecret,
      vpc: props.vpc,
    });

    this.ontologyAgentRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['bedrock-agentcore:InvokeGateway'],
        resources: [this.neptuneGateway.gatewayArn],
      })
    );

    this.queryAgentRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['bedrock-agentcore:InvokeGateway'],
        resources: [this.neptuneGateway.gatewayArn],
      })
    );

    // Per-runtime OTEL log groups
    const ontologyLogGroup = new logs.LogGroup(this, 'OntologyAgentLogGroup', {
      logGroupName: `/aws/bedrock-agentcore/runtimes/${props.projectName.replace(/-/g, '_')}_ontology`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    new logs.CfnLogStream(this, 'OntologyAgentRuntimeLogsStream', {
      logGroupName: ontologyLogGroup.logGroupName,
      logStreamName: 'runtime-logs',
    });
    const queryLogGroup = new logs.LogGroup(this, 'OntologyQueryAgentLogGroup', {
      logGroupName: `/aws/bedrock-agentcore/runtimes/${props.projectName.replace(/-/g, '_')}_ontology_query`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    new logs.CfnLogStream(this, 'OntologyQueryAgentRuntimeLogsStream', {
      logGroupName: queryLogGroup.logGroupName,
      logStreamName: 'runtime-logs',
    });

    // ============================================================
    // Deploy Runtimes
    // ============================================================
    this.ontologyRuntime = new agentcore.Runtime(this, 'OntologyGenerationRuntime', {
      runtimeName: `${props.projectName.replace(/-/g, '_')}_ontology`,
      agentRuntimeArtifact: ontologyArtifact,
      executionRole: this.ontologyAgentRole,
      description: 'AgentCore Runtime for Ontology Generation Agent',
      authorizerConfiguration: agentcore.RuntimeAuthorizerConfiguration.usingIAM(),
      networkConfiguration: agentcoreNetworkConfig,
      lifecycleConfiguration: {
        idleRuntimeSessionTimeout: cdk.Duration.minutes(15),
        maxLifetime: cdk.Duration.hours(8),
      },
      environmentVariables: {
        AWS_REGION: this.region,
        KNOWLEDGE_BASE_ID: props.bedrockKbStack.ontologyPatternsKbId,
        ARTIFACTS_BUCKET: props.dataLakeStack.artifactsBucket.bucketName,
        NEPTUNE_LOAD_ROLE: props.neptuneStack.loadRole.roleArn,
        PROJECT_NAME: props.projectName,
        NEPTUNE_GATEWAY_URL: this.neptuneGateway.gatewayUrl,
        ONTOLOGY_METADATA_TABLE: props.dynamodbStack.metadataTable.tableName,
        ATHENA_WORKGROUP: props.athenaStack.workgroup.name,
        AGENT_OBSERVABILITY_ENABLED: 'true',
        OTEL_PYTHON_DISTRO: 'aws_distro',
        OTEL_PYTHON_CONFIGURATOR: 'aws_configurator',
        OTEL_RESOURCE_ATTRIBUTES: [
          `service.name=${props.projectName.replace(/-/g, '_')}_ontology.DEFAULT`,
          `aws.log.group.names=${ontologyLogGroup.logGroupName}`,
        ].join(','),
        OTEL_EXPORTER_OTLP_LOGS_HEADERS: [
          `x-aws-log-group=${ontologyLogGroup.logGroupName}`,
          'x-aws-log-stream=runtime-logs',
          'x-aws-metric-namespace=bedrock-agentcore',
        ].join(','),
        OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
        OTEL_TRACES_EXPORTER: 'otlp',
        OTEL_METRICS_EXPORTER: 'none',
        OTEL_LOGS_EXPORTER: 'otlp',
        OTEL_TRACES_SAMPLER: 'always_on',
        OTEL_PYTHON_DISABLED_INSTRUMENTATIONS: 'botocore,requests,urllib3',
        OTEL_SEMCONV_STABILITY_OPT_IN: 'gen_ai_tool_definitions',
      },
    });

    this.queryRuntime = new agentcore.Runtime(this, 'OntologyQueryRuntime', {
      runtimeName: `${props.projectName.replace(/-/g, '_')}_ontology_query`,
      agentRuntimeArtifact: queryArtifact,
      executionRole: this.queryAgentRole,
      description: 'AgentCore Runtime for Ontology Query Agent',
      authorizerConfiguration: agentcore.RuntimeAuthorizerConfiguration.usingIAM(),
      networkConfiguration: agentcoreNetworkConfig,
      lifecycleConfiguration: {
        idleRuntimeSessionTimeout: cdk.Duration.minutes(15),
        maxLifetime: cdk.Duration.hours(8),
      },
      environmentVariables: {
        AWS_REGION: this.region,
        ATHENA_WORKGROUP: props.athenaStack.workgroup.name,
        PROJECT_NAME: props.projectName,
        ONTOLOGY_METADATA_TABLE: props.dynamodbStack.metadataTable.tableName,
        NEPTUNE_GATEWAY_URL: this.neptuneGateway.gatewayUrl,
        AGENT_OBSERVABILITY_ENABLED: 'true',
        OTEL_PYTHON_DISTRO: 'aws_distro',
        OTEL_PYTHON_CONFIGURATOR: 'aws_configurator',
        OTEL_RESOURCE_ATTRIBUTES: [
          `service.name=${props.projectName.replace(/-/g, '_')}_ontology_query.DEFAULT`,
          `aws.log.group.names=${queryLogGroup.logGroupName}`,
        ].join(','),
        OTEL_EXPORTER_OTLP_LOGS_HEADERS: [
          `x-aws-log-group=${queryLogGroup.logGroupName}`,
          'x-aws-log-stream=runtime-logs',
          'x-aws-metric-namespace=bedrock-agentcore',
        ].join(','),
        OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
        OTEL_TRACES_EXPORTER: 'otlp',
        OTEL_METRICS_EXPORTER: 'none',
        OTEL_LOGS_EXPORTER: 'otlp',
        OTEL_TRACES_SAMPLER: 'always_on',
        OTEL_PYTHON_DISABLED_INSTRUMENTATIONS: 'botocore,requests,urllib3',
        OTEL_SEMCONV_STABILITY_OPT_IN: 'gen_ai_tool_definitions',
      },
    });

    this.ontologyRuntime.node.addDependency(ontologyBuild.buildCompletion);
    this.queryRuntime.node.addDependency(queryBuild.buildCompletion);

    this.ontologyRuntimeArn = this.ontologyRuntime.agentRuntimeArn;
    this.queryRuntimeArn = this.queryRuntime.agentRuntimeArn;

    // ── Native log delivery (USAGE_LOGS) ─────────────────────────────────────
    const pn = props.projectName.replace(/-/g, '_');
    const runtimeDeliveries = [
      { id: 'Ontology', runtimeArn: this.ontologyRuntimeArn, runtimeName: `${pn}_ontology` },
      {
        id: 'OntologyQuery',
        runtimeArn: this.queryRuntimeArn,
        runtimeName: `${pn}_ontology_query`,
      },
    ];

    for (const { id, runtimeArn, runtimeName } of runtimeDeliveries) {
      const baseName = runtimeName.replace(/_/g, '-');

      const usageLogGroup = new logs.LogGroup(this, `${id}UsageLogGroup`, {
        logGroupName: `/aws/bedrock-agentcore/runtimes/${runtimeName}-usage`,
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });
      usageLogGroup.addToResourcePolicy(
        new iam.PolicyStatement({
          sid: `AllowUsageDelivery${id}`,
          principals: [new iam.ServicePrincipal('delivery.logs.amazonaws.com')],
          actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
          resources: [`${usageLogGroup.logGroupArn}:log-stream:*`],
          conditions: {
            StringEquals: { 'aws:SourceAccount': this.account },
            ArnLike: { 'aws:SourceArn': `arn:aws:logs:${this.region}:${this.account}:*` },
          },
        })
      );

      const usageLogsSrc = new logs.CfnDeliverySource(this, `${id}UsageLogsSrc`, {
        name: `${baseName}-usage-src`,
        resourceArn: runtimeArn,
        logType: 'USAGE_LOGS',
      });
      const usageLogsDest = new logs.CfnDeliveryDestination(this, `${id}UsageLogsDest`, {
        name: `${baseName}-usage-dest`,
        destinationResourceArn: usageLogGroup.logGroupArn,
      });
      new logs.CfnDelivery(this, `${id}UsageLogsDelivery`, {
        deliverySourceName: usageLogsSrc.ref,
        deliveryDestinationArn: usageLogsDest.attrArn,
      });
    }

    // ── cloud.resource_id post-creation injection ─────────────────────────────
    // The runtime ARN can't self-reference at CloudFormation create time, so we
    // inject cloud.resource_id into OTEL_RESOURCE_ATTRIBUTES post-creation via
    // a Lambda custom resource.
    const cloudResourceIdHandlerDir = path.join(__dirname, 'agentcore-cloud-resource-id-handler');
    const cloudResourceIdHandler = new lambda.Function(this, 'CloudResourceIdHandler', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.on_event',
      code: lambda.Code.fromAsset(cloudResourceIdHandlerDir, {
        bundling: {
          image: lambda.Runtime.PYTHON_3_12.bundlingImage,
          local: {
            tryBundle(outputDir: string): boolean {
              try {
                execSync(
                  `pip install --quiet --target "${outputDir}" -r "${path.join(cloudResourceIdHandlerDir, 'requirements.txt')}"`,
                  { stdio: 'pipe' }
                );
                for (const f of fs.readdirSync(cloudResourceIdHandlerDir)) {
                  if (f.endsWith('.py')) {
                    fs.copyFileSync(
                      path.join(cloudResourceIdHandlerDir, f),
                      path.join(outputDir, f)
                    ); // nosemgrep: path-join-resolve-traversal,detect-non-literal-fs-filename — CDK synth-time paths, not user input
                  }
                }
                return true;
              } catch {
                return false;
              }
            },
          },
          command: [
            'bash',
            '-c',
            'pip install --quiet --target /asset-output -r requirements.txt && cp *.py /asset-output/',
          ],
        },
      }),
      timeout: cdk.Duration.minutes(5),
      description:
        'Injects cloud.resource_id into AgentCore Runtime OTEL_RESOURCE_ATTRIBUTES post-creation',
    });

    cloudResourceIdHandler.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['bedrock-agentcore:GetAgentRuntime', 'bedrock-agentcore:UpdateAgentRuntime'],
        resources: ['*'],
      })
    );

    cloudResourceIdHandler.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['logs:CreateLogStream'],
        resources: [
          `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/bedrock-agentcore/runtimes/*:*`,
        ],
      })
    );

    cloudResourceIdHandler.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['iam:PassRole'],
        resources: [this.ontologyAgentRole.roleArn, this.queryAgentRole.roleArn],
      })
    );

    const cloudResourceIdProvider = new cr.Provider(this, 'CloudResourceIdProvider', {
      onEventHandler: cloudResourceIdHandler,
    });

    // Bump this when OTEL_* env vars change to force re-injection of cloud.resource_id.
    const otelEnvFingerprint = 'v4-stable-semconv';

    const cloudResourceIdRuntimes = [
      { id: 'Ontology', runtimeArn: this.ontologyRuntimeArn },
      { id: 'OntologyQuery', runtimeArn: this.queryRuntimeArn },
    ];
    for (const { id, runtimeArn } of cloudResourceIdRuntimes) {
      new cdk.CustomResource(this, `${id}CloudResourceId`, {
        serviceToken: cloudResourceIdProvider.serviceToken,
        properties: {
          AgentRuntimeArn: runtimeArn,
          Region: this.region,
          OtelEnvFingerprint: otelEnvFingerprint,
        },
      });
    }

    // ============================================================
    // Outputs
    // ============================================================
    new cdk.CfnOutput(this, 'AgentRepositoryUri', {
      value: this.agentRepository.repositoryUri,
      description: 'ECR repository URI for agent images',
      exportName: `${props.projectName}-agent-repo`,
    });

    new cdk.CfnOutput(this, 'OntologyAgentRoleArn', {
      value: this.ontologyAgentRole.roleArn,
      description: 'IAM role for ontology generation agent',
      exportName: `${props.projectName}-ontology-agent-role`,
    });

    new cdk.CfnOutput(this, 'QueryAgentRoleArn', {
      value: this.queryAgentRole.roleArn,
      description: 'IAM role for ontology query agent',
      exportName: `${props.projectName}-query-agent-role`,
    });

    new cdk.CfnOutput(this, 'OntologyRuntimeArn', {
      value: this.ontologyRuntimeArn,
      description: 'AgentCore Runtime ARN for Ontology Agent',
      exportName: `${props.projectName}-ontology-runtime-arn`,
    });

    new cdk.CfnOutput(this, 'QueryRuntimeArn', {
      value: this.queryRuntimeArn,
      description: 'AgentCore Runtime ARN for Ontology Query Agent',
      exportName: `${props.projectName}-query-runtime-arn`,
    });

    new cdk.CfnOutput(this, 'OntologyRuntimeEndpoint', {
      value: cdk.Fn.join('', [
        'https://bedrock-agentcore.',
        this.region,
        '.amazonaws.com/runtimes/',
        this.ontologyRuntimeArn,
      ]),
      description: 'AgentCore Runtime endpoint for Ontology Agent',
    });

    new cdk.CfnOutput(this, 'QueryRuntimeEndpoint', {
      value: cdk.Fn.join('', [
        'https://bedrock-agentcore.',
        this.region,
        '.amazonaws.com/runtimes/',
        this.queryRuntimeArn,
      ]),
      description: 'AgentCore Runtime endpoint for Ontology Query Agent',
    });

    new cdk.CfnOutput(this, 'AgentEnvironmentConfig', {
      value: JSON.stringify({
        ONTOLOGY_AGENT: {
          AWS_REGION: this.region,
          KNOWLEDGE_BASE_ID: props.bedrockKbStack.ontologyPatternsKbId,
          ARTIFACTS_BUCKET: props.dataLakeStack.artifactsBucket.bucketName,
          NEPTUNE_LOAD_ROLE: props.neptuneStack.loadRole.roleArn,
          NEPTUNE_GATEWAY_URL: this.neptuneGateway.gatewayUrl,
          ONTOLOGY_METADATA_TABLE: props.dynamodbStack.metadataTable.tableName,
          ATHENA_WORKGROUP: props.athenaStack.workgroup.name,
        },
        QUERY_AGENT: {
          AWS_REGION: this.region,
          ATHENA_WORKGROUP: props.athenaStack.workgroup.name,
          NEPTUNE_GATEWAY_URL: this.neptuneGateway.gatewayUrl,
        },
      }),
      description: 'Environment configuration for agents (Neptune access via Gateway)',
    });

    // LakeFormation CfnPermissions fail to delete when the underlying Glue/DynamoDB resources
    // are removed first. Retaining them is safe because they become a no-op once the
    // underlying resources are gone.
    this.node.findAll().forEach((child) => {
      if (child instanceof lakeformation.CfnPermissions) {
        child.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
      }
    });
  }
}
