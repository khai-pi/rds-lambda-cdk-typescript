import { SecretsManager } from '@aws-sdk/client-secrets-manager';
import { createConnection, Connection } from 'mysql2/promise';
import { 
  APIGatewayProxyHandler, 
  APIGatewayProxyEvent, 
  APIGatewayProxyResult 
} from 'aws-lambda';

const secretsManager = new SecretsManager();

interface DBSecret {
  username: string;
  password: string;
}

interface QueryParams {
  limit: string;
  offset: string;
}

export const handler: APIGatewayProxyHandler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  let connection: Connection | undefined;
  
  try {
    // Parse query parameters with proper type handling
    const queryParams: QueryParams = {
      limit: '10',  // default value
      offset: '0'   // default value
    };

    if (event.queryStringParameters) {
      // Safely handle potentially undefined values
      const { limit, offset } = event.queryStringParameters;
      if (limit !== undefined) queryParams.limit = limit;
      if (offset !== undefined) queryParams.offset = offset;
    }

    // Get database credentials from Secrets Manager
    const secretResponse = await secretsManager.getSecretValue({
      SecretId: process.env.DB_SECRET_ARN!,
    });
    
    if (!secretResponse.SecretString) {
      throw new Error('Database credentials not found');
    }

    const dbSecret: DBSecret = JSON.parse(secretResponse.SecretString);
    
    // Validate environment variables
    if (!process.env.DB_HOST) {
      throw new Error('DB_HOST environment variable is not set');
    }

    // Create database connection
    connection = await createConnection({
      host: process.env.DB_HOST,
      port: parseInt(process.env.DB_PORT || '3306'),
      user: dbSecret.username,
      password: dbSecret.password,
      database: 'mydb',
      ssl: process.env.NODE_ENV === 'production' ? {} : undefined // Enable SSL in production
    });

    // Example query with pagination and parameter validation
    const limit = Math.min(parseInt(queryParams.limit), 100); // Cap at 100 items
    const offset = Math.max(parseInt(queryParams.offset), 0); // Ensure non-negative

    const [rows] = await connection.execute(
      'SELECT * FROM users LIMIT ? OFFSET ?',
      [limit, offset]
    );
    
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
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

    if (error instanceof Error) {
      switch (error.message) {
        case 'Database credentials not found':
          statusCode = 403;
          errorMessage = error.message;
          break;
        case 'DB_HOST environment variable is not set':
          statusCode = 500;
          errorMessage = 'Server configuration error';
          break;
        default:
          if (error.message.includes('ECONNREFUSED')) {
            statusCode = 503;
            errorMessage = 'Database connection failed';
          }
      }
    }

    return {
      statusCode,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({ 
        message: errorMessage,
        errorType: error instanceof Error ? error.name : 'UnknownError'
      })
    };
  } finally {
    if (connection) {
      try {
        await connection.end();
      } catch (error) {
        console.error('Error closing database connection:', error);
      }
    }
  }
};