import { SecretsManager } from '@aws-sdk/client-secrets-manager';
import { Pool } from 'pg';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  console.log('Event:', JSON.stringify(event, null, 2));
  
  try {
    // Get DB credentials from Secrets Manager
    console.log('Getting DB credentials...');
    const secretsManager = new SecretsManager();
    const secretArn = process.env.DB_SECRET_ARN!;
    
    console.log('Fetching secret:', secretArn);
    const secretResponse = await secretsManager.getSecretValue({
      SecretId: secretArn
    });
    
    if (!secretResponse.SecretString) {
      throw new Error('Database credentials not found');
    }
    
    const credentials = JSON.parse(secretResponse.SecretString);
    console.log('Got credentials successfully');

    // Initialize DB pool
    console.log('Initializing DB pool...');
    const pool = new Pool({
      user: credentials.username,
      password: credentials.password,
      host: process.env.DB_HOST,
      port: parseInt(process.env.DB_PORT || '5432'),
      database: process.env.DB_NAME,
      ssl: {
        rejectUnauthorized: false
      }
    });

    // Handle different HTTP methods
    switch (event.httpMethod) {
      case 'GET':
        console.log('Executing GET query...');
        const result = await pool.query('SELECT NOW()');
        await pool.end();
        
        return {
          statusCode: 200,
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            message: 'Database connection successful',
            timestamp: result.rows[0].now
          })
        };

      case 'POST':
        const body = JSON.parse(event.body || '{}');
        await pool.end();
        
        return {
          statusCode: 200,
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            message: 'POST request successful',
            body: body
          })
        };

      default:
        return {
          statusCode: 405,
          body: JSON.stringify({
            message: 'Method not allowed'
          })
        };
    }
  } catch (error) {
    console.error('Error details:', {
      message: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
      name: error instanceof Error ? error.name : 'Unknown',
      env: {
        DB_HOST: process.env.DB_HOST,
        DB_PORT: process.env.DB_PORT,
        DB_NAME: process.env.DB_NAME,
        HAS_SECRET_ARN: !!process.env.DB_SECRET_ARN
      }
    });

    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        message: 'Internal server error',
        error: error instanceof Error ? error.message : 'Unknown error'
      })
    };
  }
};