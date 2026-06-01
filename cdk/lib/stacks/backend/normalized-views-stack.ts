import * as cdk from 'aws-cdk-lib';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as glue from 'aws-cdk-lib/aws-glue';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lakeformation from 'aws-cdk-lib/aws-lakeformation';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as path from 'path';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import { DataLakeStack } from './data-lake-stack';
import { ZeroEtlStack } from './zeroetl';

export interface NormalizedViewsStackProps extends cdk.StackProps {
  projectName: string;
  dataLakeStack: DataLakeStack;
  zeroEtlStack: ZeroEtlStack;
  refreshIntervalHours?: number; // default 6
  /** Additional principals (human/SSO roles) to retain as LF admins across redeploys. */
  additionalLakeFormationAdmins?: string[];
}

export class NormalizedViewsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: NormalizedViewsStackProps) {
    super(scope, id, props);

    const refreshHours = props.refreshIntervalHours ?? 6;
    const bucketName = props.dataLakeStack.tableBucketName;
    const artifactsBucket = props.dataLakeStack.artifactsBucket;

    // ── IAM role ────────────────────────────────────────────────────────────
    const jobRole = new iam.Role(this, 'GlueMVJobRole', {
      assumedBy: new iam.ServicePrincipal('glue.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSGlueServiceRole'),
      ],
      inlinePolicies: {
        S3TablesPolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: [
                's3tables:GetTableBucket',
                's3tables:ListNamespaces',
                's3tables:GetNamespace',
                's3tables:CreateNamespace',
                's3tables:ListTables',
                's3tables:GetTable',
                's3tables:PutTableMaintenanceConfiguration',
                // Data access — required when lakeformation-enabled=false (IAM-direct / hybrid mode)
                's3tables:GetTableData',
                's3tables:PutTableData',
                's3tables:GetTableMetadataLocation',
                's3tables:UpdateTableMetadataLocation',
                's3tables:CreateTable',
                's3tables:DeleteTable',
              ],
              resources: [
                `arn:aws:s3tables:${this.region}:${this.account}:bucket/${bucketName}`,
                `arn:aws:s3tables:${this.region}:${this.account}:bucket/${bucketName}/*`,
              ],
            }),
            // AWSGlueServiceRole only permits s3://aws-glue-* — grant explicit read on artifacts bucket
            new iam.PolicyStatement({
              actions: ['s3:GetObject', 's3:ListBucket'],
              resources: [artifactsBucket.bucketArn, `${artifactsBucket.bucketArn}/*`],
            }),
          ],
        }),
        LakeFormationPolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['lakeformation:GetDataAccess'],
              resources: ['*'],
            }),
          ],
        }),
        GlueDataCatalogPolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: [
                'glue:GetCatalog',
                'glue:GetCatalogs',
                'glue:GetTable',
                'glue:GetTables',
                'glue:CreateTable',
                'glue:UpdateTable',
                'glue:GetDatabase',
                'glue:GetDatabases',
              ],
              resources: [
                `arn:aws:glue:${this.region}:${this.account}:catalog`,
                `arn:aws:glue:${this.region}:${this.account}:catalog/s3tablescatalog`,
                `arn:aws:glue:${this.region}:${this.account}:catalog/s3tablescatalog/${bucketName}`,
                `arn:aws:glue:${this.region}:${this.account}:database/*`,
                `arn:aws:glue:${this.region}:${this.account}:table/*/*`,
              ],
            }),
          ],
        }),
      },
    });

    // PassRole on itself (required for MV auto-refresh)
    jobRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['iam:PassRole'],
        resources: [jobRole.roleArn],
      })
    );

    // Apply cdk-nag suppressions for Glue MV job role
    // IAM4: AWSGlueServiceRole is required for Glue jobs to access the Glue Data Catalog
    NagSuppressions.addResourceSuppressions(jobRole, [
      {
        id: 'AwsSolutions-IAM4',
        reason:
          'AWSGlueServiceRole is the standard AWS managed policy required for Glue jobs to access the Glue Data Catalog and perform automated schema/table management',
        appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSGlueServiceRole'],
      },
    ]);

    // ── Pre-create 'normalized' namespace so LF grant can reference it ───────
    // Lake Formation cannot grant permissions on a database that doesn't exist yet.
    // The Glue job creates the namespace at runtime, so we also create it here
    // during CDK deploy via a custom resource (idempotent — ConflictException is ignored).
    const tableBucketArn = `arn:aws:s3tables:${this.region}:${this.account}:bucket/${bucketName}`;

    const createNormalizedNs = new cr.AwsCustomResource(this, 'CreateNormalizedNamespace', {
      onCreate: {
        service: 'S3Tables',
        action: 'createNamespace',
        parameters: {
          tableBucketARN: tableBucketArn,
          namespace: ['normalized'],
        },
        physicalResourceId: cr.PhysicalResourceId.of('normalized-namespace'),
        ignoreErrorCodesMatching: 'ConflictException',
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['s3tables:CreateNamespace', 's3tables:GetNamespace'],
          resources: [tableBucketArn],
        }),
      ]),
    });

    // ── Lake Formation access on source zetl_* namespaces ───────────────────
    // lakeformation:GrantPermissions on s3tablescatalog/<bucket> federated
    // sub-catalog databases fails — the API rejects it with
    // "Insufficient Glue permissions to access database". The only working
    // pattern (per lambda-rest-api/index.ts:246) is to register the consuming
    // role as a Lake Formation admin, which grants implicit SELECT on every
    // database in s3tablescatalog. This applies here: the MV job role reads
    // 12 zetl_<uuid> namespaces whose UUIDs change every deploy, so blanket
    // admin access is the right scope anyway.
    const s3tCatalogId = `${this.account}:s3tablescatalog/${bucketName}`;

    // Register the MV job role as an LF admin so it can read all zetl_<uuid>
    // namespaces under s3tablescatalog. Carries forward all prior admins
    // because CfnDataLakeSettings is last-writer-wins.
    const lfAdminSettings = new lakeformation.CfnDataLakeSettings(this, 'NormalizedViewsLFAdminSettings', {
      admins: [
        {
          dataLakePrincipalIdentifier: `arn:aws:iam::${this.account}:role/cdk-hnb659fds-cfn-exec-role-${this.account}-${this.region}`,
        },
        {
          dataLakePrincipalIdentifier: `arn:aws:iam::${this.account}:role/cdk-hnb659fds-deploy-role-${this.account}-${this.region}`,
        },
        { dataLakePrincipalIdentifier: props.dataLakeStack.lfGrantSingletonRoleArn },
        { dataLakePrincipalIdentifier: jobRole.roleArn },
        ...(props.additionalLakeFormationAdmins ?? []).map((arn) => ({
          dataLakePrincipalIdentifier: arn,
        })),
      ],
    });
    lfAdminSettings.node.addDependency(props.zeroEtlStack);

    // Grant CREATE_TABLE on the target 'normalized' namespace
    const lfNormalizedGrant = new lakeformation.CfnPermissions(this, 'LFNormalizedDbGrant', {
      dataLakePrincipal: { dataLakePrincipalIdentifier: jobRole.roleArn },
      resource: {
        databaseResource: {
          catalogId: s3tCatalogId,
          name: 'normalized',
        },
      },
      permissions: ['CREATE_TABLE', 'DESCRIBE'],
    });
    lfNormalizedGrant.node.addDependency(createNormalizedNs);

    // ── Upload Glue script to artifacts bucket ───────────────────────────────
    new s3deploy.BucketDeployment(this, 'GlueScriptDeploy', {
      sources: [s3deploy.Source.asset(path.join(__dirname, '../../../../glue'))],
      destinationBucket: artifactsBucket,
      destinationKeyPrefix: 'glue-scripts',
    });

    // Spark --conf chain for S3Tables catalog
    // warehouse is required by the Glue catalog plugin to initialize (fixes NPE: region must not be null)
    const sparkConf = [
      'spark.sql.extensions=org.apache.iceberg.spark.extensions.IcebergSparkSessionExtensions',
      'spark.sql.catalog.s3t_catalog=org.apache.iceberg.spark.SparkCatalog',
      'spark.sql.catalog.s3t_catalog.type=glue',
      `spark.sql.catalog.s3t_catalog.glue.id=${this.account}:s3tablescatalog/${bucketName}`,
      `spark.sql.catalog.s3t_catalog.glue.account-id=${this.account}`,
      'spark.sql.catalog.s3t_catalog.glue.lakeformation-enabled=false',
      `spark.sql.catalog.s3t_catalog.glue.region=${this.region}`,
      // client.region is required by LakeFormationAwsClientFactory (S3FileIO with LF enabled)
      // to build table ARNs — glue.region alone is not sufficient
      `spark.sql.catalog.s3t_catalog.client.region=${this.region}`,
      `spark.sql.catalog.s3t_catalog.warehouse=s3://${artifactsBucket.bucketName}/mv-warehouse`,
      'spark.sql.defaultCatalog=s3t_catalog',
      'spark.sql.optimizer.answerQueriesWithMVs.enabled=true',
      'spark.sql.materializedViews.metadataCache.enabled=true',
      'spark.sql.optimizer.incrementalMVRefresh.enabled=true',
      'spark.sql.optimizer.incrementalMVRefresh.deltaThresholdCheckEnabled=false',
    ].join(' --conf ');

    // ── Glue 5.1 job ─────────────────────────────────────────────────────────
    const glueJob = new glue.CfnJob(this, 'NormalizedViewsJob', {
      name: `${props.projectName}-create-normalized-views`,
      role: jobRole.roleArn,
      glueVersion: '5.1',
      command: {
        name: 'glueetl',
        pythonVersion: '3',
        scriptLocation: `s3://${artifactsBucket.bucketName}/glue-scripts/create-normalized-views.py`,
      },
      defaultArguments: {
        '--enable-glue-datacatalog': 'true',
        '--conf': sparkConf,
        '--table_bucket_name': bucketName,
        '--account_id': this.account,
        '--region': this.region,
        '--refresh_hours': String(refreshHours),
      },
      executionProperty: { maxConcurrentRuns: 1 },
      timeout: 120,
    });

    // ── EventBridge schedule trigger ─────────────────────────────────────────
    const rule = new events.Rule(this, 'NormalizedViewsSchedule', {
      schedule: events.Schedule.rate(cdk.Duration.hours(refreshHours)),
      description: `Trigger ${props.projectName} normalized views Glue job every ${refreshHours}h`,
    });
    rule.addTarget(
      new targets.AwsApi({
        service: 'Glue',
        action: 'startJobRun',
        parameters: {
          JobName: glueJob.ref,
          Arguments: {
            '--table_bucket_name': bucketName,
            '--account_id': this.account,
            '--region': this.region,
            '--refresh_hours': String(refreshHours),
          },
        },
      })
    );

    // ── Initial run on deploy ────────────────────────────────────────────────
    // The schedule rule fires every refreshHours, so without this a fresh
    // deploy leaves the 'normalized' namespace empty until the first scheduled
    // tick (up to refreshHours later). Fire-and-forget StartJobRun on Create
    // populates it immediately. The LF admin registration above ensures the
    // job role can read all zetl_* namespaces before the first invocation.
    const initialRun = new cr.AwsCustomResource(this, 'InitialJobRun', {
      onCreate: {
        service: 'Glue',
        action: 'startJobRun',
        parameters: {
          JobName: glueJob.ref,
          Arguments: {
            '--table_bucket_name': bucketName,
            '--account_id': this.account,
            '--region': this.region,
            '--refresh_hours': String(refreshHours),
          },
        },
        physicalResourceId: cr.PhysicalResourceId.of(`${glueJob.ref}-initial-run`),
        // ConcurrentRunsExceededException: schedule rule already fired; skip.
        ignoreErrorCodesMatching: 'ConcurrentRunsExceededException',
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['glue:StartJobRun'],
          resources: [`arn:aws:glue:${this.region}:${this.account}:job/${glueJob.ref}`],
        }),
      ]),
    });
    initialRun.node.addDependency(glueJob);
    initialRun.node.addDependency(lfAdminSettings);
    initialRun.node.addDependency(lfNormalizedGrant);

    NagSuppressions.addResourceSuppressions(initialRun, [
      { id: 'AwsSolutions-IAM4', reason: 'AWSLambdaBasicExecutionRole used by AwsCustomResource framework' },
      { id: 'AwsSolutions-IAM5', reason: 'AwsCustomResource framework wildcard scoped to its own Lambda' },
      { id: 'AwsSolutions-L1', reason: 'AwsCustomResource framework Lambda runtime is library-controlled' },
    ], true);
  }
}
