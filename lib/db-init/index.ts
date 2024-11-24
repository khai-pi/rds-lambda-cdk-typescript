import { SecretsManager } from '@aws-sdk/client-secrets-manager';
import { createConnection } from 'mysql2/promise';
import { 
  CloudFormationCustomResourceEvent, 
  CloudFormationCustomResourceResponse,
  Context 
} from 'aws-lambda';

interface DatabaseSecret {
  username: string;
  password: string;
}

interface DatabaseConfig {
  host: string;
  port: number;
  database: string;
}

export class DatabaseInitializer {
  private readonly secretsManager: SecretsManager;
  private readonly config: DatabaseConfig;

  constructor(secretsManager: SecretsManager, config: DatabaseConfig) {
    this.secretsManager = secretsManager;
    this.config = config;
  }

  public async getCredentials(secretArn: string): Promise<DatabaseSecret> {
    try {
      const secretResponse = await this.secretsManager.getSecretValue({
        SecretId: secretArn
      });

      if (!secretResponse.SecretString) {
        throw new Error('Database credentials not found in secret');
      }

      const credentials = JSON.parse(secretResponse.SecretString);
      
      if (!credentials.username || !credentials.password) {
        throw new Error('Invalid secret format: missing required credentials');
      }

      return credentials as DatabaseSecret;
    } catch (error) {
      throw new Error(`Failed to retrieve database credentials: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  public async initializeDatabase(credentials: DatabaseSecret, isCreate: boolean): Promise<void> {
    const connection = await createConnection({
      host: this.config.host,
      port: this.config.port,
      user: credentials.username,
      password: credentials.password,
      database: this.config.database,
      connectTimeout: 10000 // 10 second timeout
    });

    try {
      // Enable strict mode for better security
      await connection.execute("SET sql_mode='STRICT_ALL_TABLES,NO_ZERO_DATE,NO_ZERO_IN_DATE,ERROR_FOR_DIVISION_BY_ZERO'");

      // Create users table with additional security features
      await connection.execute(`
        CREATE TABLE IF NOT EXISTS users (
          id INT AUTO_INCREMENT PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          email VARCHAR(255) UNIQUE NOT NULL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          deleted_at TIMESTAMP NULL DEFAULT NULL,
          status ENUM('active', 'suspended', 'deleted') NOT NULL DEFAULT 'active',
          last_login TIMESTAMP NULL DEFAULT NULL,
          INDEX idx_email (email),
          INDEX idx_status (status),
          INDEX idx_deleted_at (deleted_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
      
    } finally {
      await connection.end();
    }
  }

  public async validateEnvironment(): Promise<void> {
    if (!process.env.DB_SECRET_ARN) {
      throw new Error('DB_SECRET_ARN environment variable is required');
    }
    if (!this.config.host) {
      throw new Error('Database host configuration is required');
    }
    if (!this.config.port || this.config.port < 0 || this.config.port > 65535) {
      throw new Error('Invalid database port configuration');
    }
  }

  public createResponse(
    event: CloudFormationCustomResourceEvent,
    status: 'SUCCESS' | 'FAILED',
    reason: string
  ): CloudFormationCustomResourceResponse {
    return {
      RequestId: event.RequestId,
      LogicalResourceId: event.LogicalResourceId,
      PhysicalResourceId: 'DBInitialization',
      StackId: event.StackId,
      Status: status,
      Reason: reason,
      NoEcho: false
    };
  }
}

export const handler = async (
  event: CloudFormationCustomResourceEvent,
): Promise<CloudFormationCustomResourceResponse> => {
  console.log('Starting database initialization with event:', JSON.stringify(event));
  
  const initializer = new DatabaseInitializer(
    new SecretsManager(),
    {
      host: process.env.DB_HOST || '',
      port: parseInt(process.env.DB_PORT || '3306'),
      database: process.env.DB_NAME || 'mydb'
    }
  );

  try {
    await initializer.validateEnvironment();
    
    const credentials = await initializer.getCredentials(process.env.DB_SECRET_ARN!);
    await initializer.initializeDatabase(credentials, event.RequestType === 'Create');

    return initializer.createResponse(
      event,
      'SUCCESS',
      'Database initialization completed successfully'
    );
  } catch (error) {
    console.error('Database initialization failed:', error);
    
    return initializer.createResponse(
      event,
      'FAILED',
      `Database initialization failed: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
};