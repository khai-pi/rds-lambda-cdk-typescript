import { SecretsManager } from '@aws-sdk/client-secrets-manager';
import { createConnection } from 'mysql2/promise';
import { 
  CloudFormationCustomResourceEvent, 
  CloudFormationCustomResourceResponse 
} from 'aws-lambda';

export const handler = async (
  event: CloudFormationCustomResourceEvent
): Promise<CloudFormationCustomResourceResponse> => {
  const physicalId = 'DBInitialization';
  
  try {
    // Get database credentials
    const secretsManager = new SecretsManager();
    const secretResponse = await secretsManager.getSecretValue({
      SecretId: process.env.DB_SECRET_ARN!
    });

    if (!secretResponse.SecretString) {
      throw new Error('Database credentials not found');
    }

    const dbSecret = JSON.parse(secretResponse.SecretString);

    // Create database connection
    const connection = await createConnection({
      host: process.env.DB_HOST,
      port: parseInt(process.env.DB_PORT || '3306'),
      user: dbSecret.username,
      password: dbSecret.password,
      database: 'mydb'
    });

    // Create users table
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_email (email)
      )
    `);

    // Optional: Add some sample data
    if (event.RequestType === 'Create') {
      await connection.execute(`
        INSERT IGNORE INTO users (name, email) VALUES
        ('John Doe', 'john@example.com'),
        ('Jane Smith', 'jane@example.com')
      `);
    }

    await connection.end();

    // Return successful response with all required properties
    return {
      RequestId: event.RequestId,
      LogicalResourceId: event.LogicalResourceId,
      PhysicalResourceId: physicalId,
      StackId: event.StackId,
      Status: 'SUCCESS',
      Reason: 'Database initialization completed successfully',
      NoEcho: false
    };
  } catch (error) {
    console.error('Error:', error);
    
    // Return error response with all required properties
    return {
      RequestId: event.RequestId,
      LogicalResourceId: event.LogicalResourceId,
      PhysicalResourceId: physicalId,
      StackId: event.StackId,
      Status: 'FAILED',
      Reason: `Database initialization failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      NoEcho: false
    };
  }
};