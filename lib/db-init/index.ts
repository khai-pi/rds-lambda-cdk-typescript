import { SecretsManager } from '@aws-sdk/client-secrets-manager';
import { Pool, PoolClient } from 'pg';
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
    const pool = new Pool({
      host: this.config.host,
      port: this.config.port,
      user: credentials.username,
      password: credentials.password,
      database: this.config.database,
      ssl: {
        rejectUnauthorized: false // Note: In production, configure proper SSL
      },
      connectionTimeoutMillis: 10000 // 10 second timeout
    });

    let client: PoolClient | null = null;
    try {
      client = await pool.connect();

      // Set timezone and other session parameters
      await client.query(`
        SET TIME ZONE 'UTC';
        SET search_path TO public;
      `);

      // Create extensions if needed
      await client.query(`
        CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
        CREATE EXTENSION IF NOT EXISTS "pgcrypto";
      `);

      // Create custom types
      await client.query(`
        DO $$ 
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_status') THEN
            CREATE TYPE user_status AS ENUM ('active', 'suspended', 'deleted');
          END IF;
        END $$;
      `);

      // Create users table with PostgreSQL-specific features
      await client.query(`
        CREATE TABLE IF NOT EXISTS users (
          id SERIAL PRIMARY KEY,
          uuid UUID DEFAULT uuid_generate_v4() NOT NULL UNIQUE,
          name VARCHAR(255) NOT NULL,
          email VARCHAR(255) NOT NULL,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
          deleted_at TIMESTAMP WITH TIME ZONE,
          status user_status NOT NULL DEFAULT 'active',
          last_login TIMESTAMP WITH TIME ZONE,
          CONSTRAINT users_email_unique UNIQUE (email)
        );

        -- Create indexes
        CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);
        CREATE INDEX IF NOT EXISTS idx_users_status ON users (status);
        CREATE INDEX IF NOT EXISTS idx_users_deleted_at ON users (deleted_at);
        
        -- Create updated_at trigger
        CREATE OR REPLACE FUNCTION update_updated_at()
        RETURNS TRIGGER AS $$
        BEGIN
          NEW.updated_at = CURRENT_TIMESTAMP;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;

        -- Drop trigger if exists and create it
        DROP TRIGGER IF EXISTS users_updated_at ON users;
        CREATE TRIGGER users_updated_at
          BEFORE UPDATE ON users
          FOR EACH ROW
          EXECUTE FUNCTION update_updated_at();
      `);

      // Add any additional security policies
      await client.query(`
        -- Row Level Security (RLS)
        ALTER TABLE users ENABLE ROW LEVEL SECURITY;
        
        -- Create policy for soft delete
        CREATE POLICY users_soft_delete ON users
          FOR ALL
          USING (deleted_at IS NULL);
          
        -- Create policy for status check
        CREATE POLICY users_active_only ON users
          FOR ALL
          USING (status = 'active');
      `);

    } catch (error) {
      console.error('Error during database initialization:', error);
      throw error;
    } finally {
      if (client) {
        client.release();
      }
      await pool.end();
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
      port: parseInt(process.env.DB_PORT || '5432'), // PostgreSQL default port
      database: process.env.DB_NAME || 'postgres'
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