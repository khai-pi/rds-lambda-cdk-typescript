import { SecretsManager } from '@aws-sdk/client-secrets-manager';
import { createConnection, Connection, RowDataPacket } from 'mysql2/promise';
import { APIGatewayProxyResult, CloudFormationCustomResourceEvent } from 'aws-lambda';
import { handler as dbInitHandler } from '../lib/db-init';
import { handler as lambdaHandler } from '../lambda/handler';
import { error } from 'console';

// Mock AWS SDK and mysql2
jest.mock('@aws-sdk/client-secrets-manager');
jest.mock('mysql2/promise');

describe('Database Tests', () => {
  // Setup environment variables
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetAllMocks();
    process.env = {
      ...originalEnv,
      DB_HOST: 'test-host',
      DB_PORT: '3306',
      DB_SECRET_ARN: 'test-secret-arn'
    };
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.clearAllMocks();
  });

  // Mock database data
  const mockUsers = [
    { id: 1, name: 'John Doe', email: 'john@example.com' },
    { id: 2, name: 'Jane Smith', email: 'jane@example.com' }
  ];

  // Test DB Initialization
  describe('Database Initialization', () => {
    const mockEvent: CloudFormationCustomResourceEvent = {
      RequestType: 'Create',
      ServiceToken: 'test-token',
      ResponseURL: 'test-url',
      StackId: 'test-stack-id',
      RequestId: 'test-request-id',
      LogicalResourceId: 'test-resource-id',
      ResourceType: 'Custom::DBInit',
      ResourceProperties: {
        ServiceToken: 'test-token'
      }
    };

    test('successfully creates users table', async () => {
      // Mock Secrets Manager
      const mockGetSecretValue = jest.fn().mockResolvedValue({
        SecretString: JSON.stringify({
          username: 'testuser',
          password: 'testpass'
        })
      });

      (SecretsManager as jest.Mock).mockImplementation(() => ({
        getSecretValue: mockGetSecretValue
      }));

      // Mock database connection and queries
     const mockExecute = jest.fn()
        .mockResolvedValueOnce([[]]) // SQL mode
        .mockResolvedValueOnce([[]]) // CREATE TABLE
        .mockResolvedValueOnce([[{ count: 0 }]]) // SELECT COUNT returns empty
        .mockResolvedValueOnce([{ affectedRows: 2 }]); // INSERT
      const mockEnd = jest.fn().mockResolvedValue(undefined);
      
      (createConnection as jest.Mock).mockResolvedValue({
        execute: mockExecute,
        end: mockEnd
      });

      const response = await dbInitHandler(mockEvent);

      // Verify successful response
      expect(response.Status).toBe('SUCCESS');
      expect(response.PhysicalResourceId).toBe('DBInitialization');

      // Verify table creation query
      expect(mockExecute).toHaveBeenCalledWith(
        expect.stringContaining('CREATE TABLE IF NOT EXISTS users')
      );

      // Verify connection was closed
      expect(mockEnd).toHaveBeenCalled();
    });

    test('handles database connection error', async () => {
      // Mock secret managers
      const mockGetSecretValue = jest.fn().mockResolvedValue({
        SecretString: JSON.stringify({
          username: 'testuser',
          password: 'testpass'
        })
      });

      (SecretsManager as jest.Mock).mockImplementation(() => ({
        getSecretValue: mockGetSecretValue
      }));

      // Mock connection failure
      (createConnection as jest.Mock).mockRejectedValue(
        new Error('Connection failed')
      );

      const response = await dbInitHandler(mockEvent);

      expect(response.Status).toBe('FAILED');
      expect(response.Reason).toContain('Connection failed');
    });

    test('handles invalid credentials', async () => {
      // Mock missing secret
      const mockGetSecretValue = jest.fn().mockResolvedValue({
        SecretString: null
      });

      (SecretsManager as jest.Mock).mockImplementation(() => ({
        getSecretValue: mockGetSecretValue
      }));

      const response = await dbInitHandler(mockEvent);

      expect(response.Status).toBe('FAILED');
      expect(response.Reason).toContain('Database credentials not found');
    });
  });

  // Test Database Queries
  describe('Database Queries', () => {
    let mockConnection: Partial<Connection>;
    
    beforeEach(() => {
      // Setup mock connection for each test
      const mockExecute = jest.fn().mockResolvedValue([mockUsers]);
      const mockEnd = jest.fn().mockResolvedValue(undefined);
      
      mockConnection = {
        execute: mockExecute,
        end: mockEnd
      };

      const mockGetSecretValue = jest.fn().mockResolvedValue({
        SecretString: JSON.stringify({
          username: 'testuser',
          password: 'testpass'
        })
      });

      (SecretsManager as jest.Mock).mockImplementation(() => ({
        getSecretValue: mockGetSecretValue
      }));

      (createConnection as jest.Mock).mockResolvedValue(mockConnection);
    });

    test('successfully queries users with pagination', async () => {
      
      const mockEvent = {
        queryStringParameters: {
          limit: '10',
          offset: '0'
        }
      };

      // Mock Secrets Manager for Lambda handler
      // const mockGetSecretValue = jest.fn().mockResolvedValue({
      //   SecretString: JSON.stringify({
      //     username: 'testuser',
      //     password: 'testpass'
      //   })
      // });

      // (SecretsManager as jest.Mock).mockImplementation(() => ({
      //   getSecretValue: mockGetSecretValue
      // }));

      const response: APIGatewayProxyResult | void = await lambdaHandler(mockEvent as any, {} as any, () => {});
      if (!response) throw error;

      expect(response.statusCode).toBe(200);
      
      const body = JSON.parse(response.body);
      expect(body.data).toEqual(mockUsers);
      expect(body.pagination).toEqual({
        limit: 10,
        offset: 0,
        nextOffset: 10
      });
    });

    test('handles invalid pagination parameters', async () => {
      const mockEvent = {
        queryStringParameters: {
          limit: '1000', // Should be capped at 100
          offset: '-5'   // Should be set to 0
        }
      };

      const response: APIGatewayProxyResult | void = await lambdaHandler(mockEvent as any, {} as any, () => {});
      if (!response) throw error;

      expect(response.statusCode).toBe(200);
      
      const body = JSON.parse(response.body);
      expect(body.pagination.limit).toBe(100); // Capped at 100
      expect(body.pagination.offset).toBe(0);  // Minimum 0
    });

    test('handles database query errors', async () => {
      // Mock query failure
      mockConnection.execute = jest.fn().mockRejectedValue(
        new Error('Query failed')
      );

      const mockEvent = {
        queryStringParameters: {
          limit: '10',
          offset: '0'
        }
      };

      const response: APIGatewayProxyResult | void = await lambdaHandler(mockEvent as any, {} as any, () => {});
      if (!response) throw error;

      expect(response.statusCode).toBe(500);
      expect(JSON.parse(response.body)).toEqual({
        message: 'Internal server error',
        errorType: 'Error'
      });
    });

    test('verifies connection cleanup', async () => {
      const mockEnd = jest.fn().mockResolvedValue(undefined);
      mockConnection.end = mockEnd;

      await lambdaHandler({ queryStringParameters: {} } as any, {} as any, () => {});

      expect(mockEnd).toHaveBeenCalled();
    });
  });

  // Test SQL Injection Prevention
  // describe('SQL Injection Prevention', () => {
  //   test('prevents SQL injection in pagination parameters', async () => {
  //     const mockExecute = jest.fn().mockResolvedValue([[]]);
  //     const mockEnd = jest.fn().mockResolvedValue(undefined);
      
  //     (createConnection as jest.Mock).mockResolvedValue({
  //       execute: mockExecute,
  //       end: mockEnd
  //     });

  //     const mockEvent = {
  //       queryStringParameters: {
  //         limit: '10; DROP TABLE users;--',
  //         offset: '0 OR 1=1'
  //       }
  //     };

  //     await lambdaHandler(mockEvent as any, {} as any, () => {});

  //     // Verify parameters are properly sanitized
  //     expect(mockExecute).toHaveBeenCalledWith(
  //       'SELECT * FROM users LIMIT ? OFFSET ?',
  //       [10, 0] // Should be converted to numbers
  //     );
  //   });
  // });
});