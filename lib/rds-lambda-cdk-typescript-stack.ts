import { 
  Stack, 
  StackProps, 
  CustomResource, 
  RemovalPolicy,
  CfnOutput,
  Duration,
  Tags
} from 'aws-cdk-lib';
import { 
  Function, 
  Runtime, 
  Code,
  Architecture
} from 'aws-cdk-lib/aws-lambda';
import { 
  Vpc, 
  SecurityGroup, 
  SubnetType, 
  Port,
  InstanceType,
  InstanceClass,
  InstanceSize,
  IpAddresses,
  Peer,
  InterfaceVpcEndpointAwsService
} from 'aws-cdk-lib/aws-ec2';
import { 
  DatabaseInstance, 
  DatabaseInstanceEngine, 
  PostgresEngineVersion,
  Credentials,
  ParameterGroup
} from 'aws-cdk-lib/aws-rds';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { Provider } from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import * as path from 'path';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { LambdaIntegration, RestApi } from 'aws-cdk-lib/aws-apigateway';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';

export class RdsLambdaCdkTypescriptStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // VPC
    const vpc = new Vpc(this, 'VpcLambda', {
      ipAddresses: IpAddresses.cidr('10.0.0.0/16'),
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'privatelambda',
          subnetType: SubnetType.PRIVATE_WITH_EGRESS,
        },
        {
          cidrMask: 24,
          name: 'public',
          subnetType: SubnetType.PUBLIC,
        },
      ],
    });

    // Add VPC Endpoints
    const secretsManagerEndpoint = vpc.addInterfaceEndpoint('SecretsManagerEndpoint', {
      service: InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
      subnets: {
        subnetType: SubnetType.PRIVATE_WITH_EGRESS
      }
    });

    // Database Security Group
    const dbSecurityGroup = new SecurityGroup(this, 'DbSecurityGroup', {
      vpc,
      description: 'Security group for PostgreSQL RDS instance',
      allowAllOutbound: false
    });

    // Database Parameter Group
    const parameterGroup = new ParameterGroup(this, 'PostgresParameterGroup', {
      engine: DatabaseInstanceEngine.postgres({ 
        version: PostgresEngineVersion.VER_13 
      }),
      parameters: {
        'max_connections': '50',
        'shared_buffers': '32768',
        'work_mem': '4096',
        'maintenance_work_mem': '65536',
        'timezone': 'UTC',
        'max_prepared_transactions': '0',
        'effective_cache_size': '98304'
      }
    });

    const databaseName = 'pgdatabase';

    // RDS Instance
    const dbInstance = new DatabaseInstance(this, 'PostgresInstance', {
      engine: DatabaseInstanceEngine.postgres({
        version: PostgresEngineVersion.VER_13,
      }),
      instanceType: InstanceType.of(InstanceClass.T3, InstanceSize.MICRO),
      vpc,
      vpcSubnets: {
        subnetType: SubnetType.PRIVATE_WITH_EGRESS,
      },
      databaseName,
      securityGroups: [dbSecurityGroup],
      credentials: Credentials.fromGeneratedSecret('postgres'),
      maxAllocatedStorage: 20,
      allocatedStorage: 5,
      allowMajorVersionUpgrade: false,
      autoMinorVersionUpgrade: true,
      backupRetention: Duration.days(7),
      deleteAutomatedBackups: true,
      removalPolicy: RemovalPolicy.DESTROY,
      parameterGroup,
      publiclyAccessible: false,
      storageEncrypted: true,
      monitoringInterval: Duration.seconds(60),
    });

    // Lambda Security Group
    const lambdaSG = new SecurityGroup(this, 'LambdaSG', {
      vpc,
      description: 'Security group for Lambda functions',
      allowAllOutbound: false
    });

    // Lambda Function
    const apiHandlerFunction = new NodejsFunction(this, 'ApiHandlerFunction', {
      runtime: Runtime.NODEJS_18_X,
      architecture: Architecture.ARM_64,
      handler: 'handler',
      entry: path.join(__dirname, '../lambda/handler.ts'),
      environment: {
        DB_HOST: dbInstance.dbInstanceEndpointAddress,
        DB_PORT: '5432',
        DB_NAME: databaseName,
        DB_SECRET_ARN: dbInstance.secret?.secretFullArn || '',
      },
      bundling: {
        externalModules: [
          '@aws-sdk/client-secrets-manager'
        ],
        nodeModules: ['pg'],
        forceDockerBundling: false,
        minify: true,
        sourceMap: true,
        target: 'node18'
      },
      depsLockFilePath: path.join(__dirname, '../lambda/package-lock.json'),
      vpc,
      vpcSubnets: {
        subnetType: SubnetType.PRIVATE_WITH_EGRESS,
      },
      securityGroups: [lambdaSG],
    });

    // Grant permissions
    dbInstance.secret?.grantRead(apiHandlerFunction);

    // Security group rules
    dbSecurityGroup.addIngressRule(
      lambdaSG,
      Port.tcp(5432),
      'Allow Lambda to access PostgreSQL'
    );

    lambdaSG.addEgressRule(
      dbSecurityGroup,
      Port.tcp(5432),
      'Allow Lambda to access PostgreSQL'
    );

    // Add egress rule for Secrets Manager VPC endpoint
    lambdaSG.addEgressRule(
      Peer.ipv4(vpc.vpcCidrBlock),
      Port.tcp(443),
      'Allow HTTPS access to VPC endpoints'
    );

    // API Gateway
    const api = new RestApi(this, 'DatabaseAPI', {
      description: 'API for PostgreSQL database operations',
      deployOptions: {
        stageName: 'dev',
      },
      defaultCorsPreflightOptions: {
        allowOrigins: ['*'],
        allowMethods: ['GET', 'POST', 'PUT', 'DELETE'],
      },
    });

    // API Resources
    const usersApi = api.root.addResource('helloworld');
    usersApi.addMethod('GET', new LambdaIntegration(apiHandlerFunction));
    usersApi.addMethod('POST', new LambdaIntegration(apiHandlerFunction));

    // Outputs
    new CfnOutput(this, 'DatabaseEndpoint', {
      value: dbInstance.dbInstanceEndpointAddress,
      description: 'Database endpoint address',
    });

    new CfnOutput(this, 'DatabaseSecretArn', {
      value: dbInstance.secret?.secretFullArn || 'No secret created',
      description: 'Database credentials secret ARN',
    });

    new CfnOutput(this, 'ApiUrl', {
      value: api.url,
      description: 'API endpoint URL',
    });

    // Tags
    Tags.of(this).add('Environment', 'Development');
    Tags.of(this).add('Project', 'PostgreSQL-Lambda');
  }
}