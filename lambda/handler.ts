import { APIGatewayProxyHandler, APIGatewayProxyResult } from 'aws-lambda';
import { SecretsManager } from '@aws-sdk/client-secrets-manager';
import { createConnection, Connection } from 'mysql2/promise';

interface DBSecret {
  username: string;
  password: string;
}

interface QueryParams {
  limit: string;
  offset: string;
}

export const handler: APIGatewayProxyHandler = async (event, context): Promise<APIGatewayProxyResult> => {
  let connection: Connection | undefined;
  
  // Set this to false to prevent connection hanging
  context.callbackWaitsForEmptyEventLoop = false;
  
  try {
    // Validate environment variables first
    if (!process.env.DB_HOST) {
      throw new Error('Server configuration error');
    }

    // Parse query parameters
    const queryParams: QueryParams = {
      limit: event.queryStringParameters?.limit || '10',
      offset: event.queryStringParameters?.offset || '0'
    };

    // Get database credentials
    const secretsManager = new SecretsManager();
    const secretResponse = await secretsManager.getSecretValue({
      SecretId: process.env.DB_SECRET_ARN!
    });

    if (!secretResponse.SecretString) {
      throw new Error('Database credentials not found');
    }

    const dbSecret: DBSecret = JSON.parse(secretResponse.SecretString);

    // Create database connection
    connection = await createConnection({
      host: process.env.DB_HOST,
      port: parseInt(process.env.DB_PORT || '3306'),
      user: dbSecret.username,
      password: dbSecret.password,
      database: 'mydb'
    }).catch(error => {
      if (error.message.includes('ECONNREFUSED')) {
        throw new Error('Database connection failed');
      }
      throw error;
    });

    // Validate and normalize parameters
    const limit = Math.min(parseInt(queryParams.limit), 100);
    const offset = Math.max(parseInt(queryParams.offset), 0);

    // Execute query
    const [rows] = await connection.execute(
      'SELECT * FROM users LIMIT ? OFFSET ?',
      [limit, offset]
    );
    
    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'Success',
        data: rows,
        pagination: {
          limit,
          offset,
          nextOffset: offset + limit
        }
      })
    };
  } catch (error) {
    console.error('Error:', error);
    
    let statusCode = 500;
    let errorMessage = 'Internal server error';
    let errorType = 'Error';

    if (error instanceof Error) {
      errorType = error.constructor.name;
      switch (error.message) {
        case 'Server configuration error':
          statusCode = 500;
          errorMessage = error.message;
          break;
        case 'Database connection failed':
          statusCode = 503;
          errorMessage = error.message;
          break;
        case 'Database credentials not found':
          statusCode = 500;
          errorMessage = error.message;
          break;
      }
    }

    return {
      statusCode,
      body: JSON.stringify({
        message: errorMessage,
        errorType
      })
    };
  } finally {
    if (connection) {
      try {
        await connection.end();
      } catch (error) {
        console.error('Error closing connection:', error);
      }
    }
  }
};