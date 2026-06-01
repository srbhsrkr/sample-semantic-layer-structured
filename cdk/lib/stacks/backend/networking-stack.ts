import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export interface NetworkingStackProps extends cdk.StackProps {
  projectName: string;
}

/**
 * Networking Stack
 * Creates VPC with public and private subnets for Neptune and other private resources
 */
export class NetworkingStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  public readonly neptuneSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: NetworkingStackProps) {
    super(scope, id, props);

    // Create VPC with public and private subnets.
    //
    // IMPORTANT: AgentCore Runtime supports only specific AZ IDs in us-east-1
    // (use1-az1, use1-az2, use1-az4; use1-az6 is NOT supported). AZ IDs are
    // stable across accounts, but AZ names (us-east-1a, us-east-1b, ...) map to
    // different AZ IDs in every account, so you MUST look up your own account's
    // mapping and update the availabilityZones list below accordingly:
    //   aws ec2 describe-availability-zones \
    //     --query 'AvailabilityZones[].[ZoneId,ZoneName]' --output table
    //
    // Pick the two AZ names that, in your account, correspond to supported AZ
    // IDs (e.g. use1-az1 and use1-az2) and set them below.
    this.vpc = new ec2.Vpc(this, 'SemanticLayerVPC', {
      vpcName: `${props.projectName}-vpc`,
      availabilityZones: ['us-east-1a', 'us-east-1c'],
      natGateways: 1,
      ipAddresses: ec2.IpAddresses.cidr('10.0.0.0/16'),
      subnetConfiguration: [
        {
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
        {
          name: 'Isolated',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
      ],
      enableDnsHostnames: true,
      enableDnsSupport: true,
      flowLogs: {
        s3: {
          destination: ec2.FlowLogDestination.toCloudWatchLogs(
            new logs.LogGroup(this, 'VpcFlowLogGroup', {
              retention: logs.RetentionDays.ONE_MONTH,
              removalPolicy: cdk.RemovalPolicy.DESTROY,
            })
          ),
        },
      },
    });

    // Security group for Neptune
    this.neptuneSecurityGroup = new ec2.SecurityGroup(this, 'NeptuneSecurityGroup', {
      vpc: this.vpc,
      description: 'Security group for Neptune cluster',
      allowAllOutbound: true,
    });

    // Allow inbound from VPC CIDR for Neptune (port 8182)
    this.neptuneSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(this.vpc.vpcCidrBlock),
      ec2.Port.tcp(8182),
      'Allow Neptune access from VPC'
    );

    // VPC Endpoints for AWS services (reduce NAT costs)

    // Gateway endpoints (free, no hourly charges)
    // S3 and DynamoDB only support Gateway endpoints, not Interface endpoints
    this.vpc.addGatewayEndpoint('S3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });

    this.vpc.addGatewayEndpoint('DynamoDBEndpoint', {
      service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
    });

    // Interface endpoints (hourly charges apply)
    // Bedrock and Athena support Interface endpoints
    this.vpc.addInterfaceEndpoint('BedrockEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.BEDROCK_RUNTIME,
    });

    this.vpc.addInterfaceEndpoint('AthenaEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.ATHENA,
    });

    // AgentCore endpoints — required for Runtime container lifecycle management
    // and invocation traffic to stay within the VPC
    this.vpc.addInterfaceEndpoint('BedrockAgentCoreEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.BEDROCK_AGENTCORE,
    });

    // AgentCore Gateway endpoint — agents in VPC mode call MCP gateways at
    // *.gateway.bedrock-agentcore.us-east-1.amazonaws.com which only resolve
    // through this private service. Without it, ontology agent persist calls
    // to the Neptune Gateway fail with DNS errors and Neptune stays empty.
    this.vpc.addInterfaceEndpoint('BedrockAgentCoreGatewayEndpoint', {
      service: new ec2.InterfaceVpcEndpointService(
        `com.amazonaws.${cdk.Stack.of(this).region}.bedrock-agentcore.gateway`,
        443,
      ),
      privateDnsEnabled: true,
    });

    // Bedrock Agent / Agent Runtime — used by KB ingestion and retrieval tools
    this.vpc.addInterfaceEndpoint('BedrockAgentEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.BEDROCK_AGENT,
    });

    this.vpc.addInterfaceEndpoint('BedrockAgentRuntimeEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.BEDROCK_AGENT_RUNTIME,
    });

    // ECR endpoints — required to pull Runtime container images from ECR
    this.vpc.addInterfaceEndpoint('EcrApiEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.ECR,
    });

    this.vpc.addInterfaceEndpoint('EcrDockerEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER,
    });

    // CloudWatch Logs — OTEL telemetry and container stdout/stderr
    this.vpc.addInterfaceEndpoint('CloudWatchLogsEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
    });

    // SSM Parameter Store — agents read Athena query-results bucket name
    this.vpc.addInterfaceEndpoint('SsmEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.SSM,
    });

    // STS — required for IAM credential resolution inside containers
    this.vpc.addInterfaceEndpoint('StsEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.STS,
    });

    // Glue — catalog access for ontology and metadata agents
    this.vpc.addInterfaceEndpoint('GlueEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.GLUE,
    });

    // Outputs
    new cdk.CfnOutput(this, 'VpcId', {
      value: this.vpc.vpcId,
      description: 'VPC ID',
      exportName: `${props.projectName}-vpc-id`,
    });

    new cdk.CfnOutput(this, 'VpcCidr', {
      value: this.vpc.vpcCidrBlock,
      description: 'VPC CIDR Block',
    });
  }
}
