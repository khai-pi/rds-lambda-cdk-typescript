import { 
  Stack, 
  StackProps, 
  CustomResource, 
  RemovalPolicy,
  CfnOutput,
  Duration 
} from 'aws-cdk-lib';
import { 
  Function, 
  Runtime, 
  Code
} from 'aws-cdk-lib/aws-lambda';
import { 
  Vpc, 
  SecurityGroup, 
  SubnetType, 
  Port,
  InstanceType,
  InstanceClass,
  InstanceSize 
} from 'aws-cdk-lib/aws-ec2';
import { 
  DatabaseInstance, 
  DatabaseInstanceEngine, 
  MysqlEngineVersion,
  Credentials 
} from 'aws-cdk-lib/aws-rds';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { 
  RestApi, 
  LambdaIntegration 
} from 'aws-cdk-lib/aws-apigateway';
import { Provider } from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import * as path from 'path';

export class RdsLambdaConstruct extends Construct {
  public readonly handler: Function;
  public readonly rdsInstance: DatabaseInstance;
  public readonly api: RestApi;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id);

    const vpc = new Vpc(this, 'RdsLambdaVpc', {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'Private',
          subnetType: SubnetType.PRIVATE_WITH_EGRESS,
        },
        {
          cidrMask: 24,
          name: 'Public',
          subnetType: SubnetType.PUBLIC,
        }
      ]
    });

    const rdsSecurityGroup = new SecurityGroup(this, 'RdsSecurityGroup', {
      vpc,
      description: 'Security group for RDS instance',
      allowAllOutbound: true,
    });

    const lambdaSecurityGroup = new SecurityGroup(this, 'LambdaSecurityGroup', {
      vpc,
      description: 'Security group for Lambda function',
      allowAllOutbound: true,
    });

    rdsSecurityGroup.addIngressRule(
      lambdaSecurityGroup,
      Port.tcp(3306),
      'Allow Lambda connection to RDS'
    );

    const databaseCredentials = new Secret(this, 'DBCredentials', {
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'admin' }),
        generateStringKey: 'password',
        excludePunctuation: true,
      },
    });

    this.rdsInstance = new DatabaseInstance(this, 'RdsInstance', {
      engine: DatabaseInstanceEngine.mysql({ 
        version: MysqlEngineVersion.VER_8_0 
      }),
      vpc,
      vpcSubnets: {
        subnetType: SubnetType.PRIVATE_WITH_EGRESS,
      },
      instanceType: InstanceType.of(
        InstanceClass.T3, 
        InstanceSize.MICRO
      ),
      securityGroups: [rdsSecurityGroup],
      credentials: Credentials.fromSecret(databaseCredentials),
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const dbInitFunction = new Function(this, 'DBInitFunction', {
      runtime: Runtime.NODEJS_18_X,
      handler: 'index.handler',
      code: Code.fromAsset(path.join(__dirname, 'db-init'), {
        bundling: {
          image: Runtime.NODEJS_18_X.bundlingImage,
          command: [
            'bash', '-c',
            'npm install && npm run build && cp -r dist/* /asset-output/'
          ],
          user: 'root',
        }
      }),
      vpc,
      vpcSubnets: {
        subnetType: SubnetType.PRIVATE_WITH_EGRESS,
      },
      securityGroups: [lambdaSecurityGroup],
      environment: {
        DB_SECRET_ARN: databaseCredentials.secretArn,
        DB_HOST: this.rdsInstance.instanceEndpoint.hostname,
        DB_PORT: '3306',
      },
      timeout: Duration.seconds(30),
    });

    databaseCredentials.grantRead(dbInitFunction);

    const dbInitProvider = new Provider(this, 'DBInitProvider', {
      onEventHandler: dbInitFunction,
    });

    new CustomResource(this, 'DBInit', {
      serviceToken: dbInitProvider.serviceToken,
      properties: {
        timestamp: Date.now(),
      },
    });

    this.handler = new Function(this, 'RdsLambdaHandler', {
      runtime: Runtime.NODEJS_18_X,
      handler: 'index.handler',
      code: Code.fromAsset('lambda', {
        bundling: {
          image: Runtime.NODEJS_18_X.bundlingImage,
          command: [
            'bash', '-c',
            'npm install && npm run build && cp -r dist/* /asset-output/'
          ],
          user: 'root',
        }
      }),
      vpc,
      vpcSubnets: {
        subnetType: SubnetType.PRIVATE_WITH_EGRESS,
      },
      securityGroups: [lambdaSecurityGroup],
      environment: {
        DB_SECRET_ARN: databaseCredentials.secretArn,
        DB_HOST: this.rdsInstance.instanceEndpoint.hostname,
        DB_PORT: '3306',
      },
      timeout: Duration.seconds(30),
    });

    databaseCredentials.grantRead(this.handler);

    this.api = new RestApi(this, 'UsersApi', {
      restApiName: 'Users Service',
      description: 'This is the Users API'
    });

    const users = this.api.root.addResource('users');
    users.addMethod('GET', new LambdaIntegration(this.handler));

    new CfnOutput(this, 'ApiEndpoint', {
      description: 'API Gateway endpoint URL',
      value: this.api.url,
      exportName: 'ApiEndpointUrl'
    });
  }
}

export class RdsLambdaCdkTypescriptStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
    new RdsLambdaConstruct(this, 'RdsLambdaConstruct');
  }
}