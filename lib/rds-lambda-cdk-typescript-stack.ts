import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as path from 'path';
import { Construct } from 'constructs';

// Custom construct for the Lambda-RDS setup
export class RdsLambdaConstruct extends Construct {
  public readonly handler: lambda.Function;
  public readonly rdsInstance: rds.DatabaseInstance;
  public readonly api: apigateway.RestApi;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id);

    // Create VPC
    const vpc = new ec2.Vpc(this, 'RdsLambdaVpc', {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
        {
          cidrMask: 24,
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
        }
      ]
    });

    // Create RDS Security Group
    const rdsSecurityGroup = new ec2.SecurityGroup(this, 'RdsSecurityGroup', {
      vpc,
      description: 'Security group for RDS instance',
      allowAllOutbound: true,
    });

    // Create Lambda Security Group
    const lambdaSecurityGroup = new ec2.SecurityGroup(this, 'LambdaSecurityGroup', {
      vpc,
      description: 'Security group for Lambda function',
      allowAllOutbound: true,
    });

    // Allow Lambda to connect to RDS
    rdsSecurityGroup.addIngressRule(
      lambdaSecurityGroup,
      ec2.Port.tcp(3306),
      'Allow Lambda connection to RDS'
    );

    // Create RDS credentials in Secrets Manager
    const databaseCredentials = new secretsmanager.Secret(this, 'DBCredentials', {
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'admin' }),
        generateStringKey: 'password',
        excludePunctuation: true,
      },
    });

    // Create RDS instance
    this.rdsInstance = new rds.DatabaseInstance(this, 'RdsInstance', {
      engine: rds.DatabaseInstanceEngine.mysql({ version: rds.MysqlEngineVersion.VER_8_0 }),
      vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
      securityGroups: [rdsSecurityGroup],
      credentials: rds.Credentials.fromSecret(databaseCredentials),
      removalPolicy: cdk.RemovalPolicy.DESTROY, // For development only
    });

    // Create Lambda function for database initialization
    const dbInitFunction = new lambda.Function(this, 'DBInitFunction', {
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'db-init')),
      vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      securityGroups: [lambdaSecurityGroup],
      environment: {
        DB_SECRET_ARN: databaseCredentials.secretArn,
        DB_HOST: this.rdsInstance.instanceEndpoint.hostname,
        DB_PORT: '3306',
      },
      timeout: cdk.Duration.seconds(30),
    });

    // Grant permissions
    databaseCredentials.grantRead(dbInitFunction);

    // Create Custom Resource
    new cr.Provider(this, 'DBInitProvider', {
      onEventHandler: dbInitFunction,
    });

    // This will run the init function when the stack is deployed
    new cdk.CustomResource(this, 'DBInit', {
      serviceToken: dbInitFunction.functionArn,
      properties: {
        timestamp: Date.now(), // Force run on every deployment
      },
    });

    // Create Lambda function
    // TODO: Bundling code
    this.handler = new lambda.Function(this, 'RdsLambdaHandler', {
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda'),
      vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      securityGroups: [lambdaSecurityGroup],
      environment: {
        DB_SECRET_ARN: databaseCredentials.secretArn,
        DB_HOST: this.rdsInstance.instanceEndpoint.hostname,
        DB_PORT: '3306',
      },
      timeout: cdk.Duration.seconds(30),
    });

    // Grant Lambda access to RDS credentials
    databaseCredentials.grantRead(this.handler);

    // Create API Gateway
    this.api = new apigateway.RestApi(this, 'UsersApi', {
      restApiName: 'Users Service',
      description: 'This is the Users API'
    });

    // Create API resource and method
    const users = this.api.root.addResource('users');
    users.addMethod('GET', new apigateway.LambdaIntegration(this.handler));

    // This will run the init function when the stack is deployed
    new cdk.CustomResource(this, 'DBInit', {
      serviceToken: dbInitFunction.functionArn,
      properties: {
        timestamp: Date.now(), // Force run on every deployment
      },
    });
    new cdk.CfnOutput(this, 'ApiEndpoint', {
      description: 'API Gateway endpoint URL',
      value: this.api.url,
      exportName: 'ApiEndpointUrl'
    });
  }
}

// Main stack
export class RdsLambdaCdkTypescriptStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Create the RDS-Lambda construct
    new RdsLambdaConstruct(this, 'RdsLambdaConstruct');
  }
}