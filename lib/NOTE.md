Output can be used in scripts
// Using AWS CLI to get stack outputs
import { exec } from 'child_process';

const getStackOutputs = async () => {
  return new Promise((resolve, reject) => {
    exec('aws cloudformation describe-stacks --stack-name RdsLambdaCdkTypescriptStack --query "Stacks[0].Outputs"', 
      (error, stdout, stderr) => {
        if (error) reject(error);
        else resolve(JSON.parse(stdout));
      });
  });
};

// Example usage
const outputs = await getStackOutputs();
const apiUrl = outputs.find(o => o.OutputKey === 'ApiEndpoint').OutputValue;

// Make API call
const response = await fetch(`${apiUrl}users?limit=10&offset=0`);
const data = await response.json();




Output can be accessed in another stack

import * as cdk from 'aws-cdk-lib';

class AnotherStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Reference output from other stack
    const apiEndpoint = cdk.Fn.importValue('ApiEndpointUrl');
    
    // Use the imported value
    new cdk.CfnOutput(this, 'ImportedApiEndpoint', {
      value: apiEndpoint,
      description: 'Imported API endpoint'
    });
  }
}
