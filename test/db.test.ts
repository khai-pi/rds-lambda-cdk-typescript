import { DatabaseInitializer } from '../lib/db-init';
import { SecretsManager } from '@aws-sdk/client-secrets-manager';
import { Pool, PoolClient, QueryResult } from 'pg';
import { CloudFormationCustomResourceEvent } from 'aws-lambda';

// Define mock types
type MockPoolClient = {
  query: jest.Mock<Promise<QueryResult<any>>>;
  release: jest.Mock;
};

type MockPool = {
  connect: jest.Mock<Promise<MockPoolClient>>;
  end: jest.Mock;
};

// Mock pg Pool and Client
jest.mock('pg', () => {
  const mockClient = {
    query: jest.fn().mockResolvedValue({} as QueryResult),
    release: jest.fn()
  };
  const mockPool = {
    connect: jest.fn().mockResolvedValue(mockClient),
    end: jest.fn()
  };
  return { 
    Pool: jest.fn(() => mockPool),
    PoolClient: jest.fn()
  };
});

// Mock AWS SecretsManager
jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManager: jest.fn().mockImplementation(() => ({
    getSecretValue: jest.fn()
  }))
}));

describe('DatabaseInitializer', () => {
  let mockSecretsManager: jest.Mocked<SecretsManager>;
  let mockPool: jest.Mocked<Pool>;
  let mockClient: jest.Mocked<PoolClient>;
  let dbInitializer: DatabaseInitializer;

  const testConfig = {
    host: 'test-host',
    port: 5432,
    database: 'test-db'
  };
  const testCredentials = {
    username: 'test-user',
    password: 'test-password'
  };

  beforeEach(() => {
    jest.clearAllMocks();

    // Setup environment variables
    process.env.DB_SECRET_ARN = 'test-secret-arn';
    process.env.DB_HOST = 'test-host';
    process.env.DB_PORT = '5432';
    process.env.DB_NAME = 'test-db';

    // Setup mocks
    const mockQuery = jest.fn().mockResolvedValue({
      rows: [],
      rowCount: 0,
      command: '',
      oid: 0,
      fields: []
    } as QueryResult);
    mockSecretsManager = new SecretsManager({}) as jest.Mocked<SecretsManager>;
    mockPool = {
      connect: jest.fn().mockResolvedValue(mockClient),
      end: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<Pool>;
    mockClient = {
      query: mockQuery,
      release: jest.fn(),
    } as unknown as jest.Mocked<PoolClient>;

    dbInitializer = new DatabaseInitializer(mockSecretsManager, testConfig);
  });

  describe('getCredentials', () => {
    test('should successfully retrieve credentials', async () => {

      (mockSecretsManager.getSecretValue as jest.Mock).mockResolvedValueOnce({
        SecretString: JSON.stringify(testCredentials)
      });

      const result = await dbInitializer.getCredentials('test-secret-arn');
      
      expect(result).toEqual(testCredentials);
      expect(mockSecretsManager.getSecretValue).toHaveBeenCalledWith({
        SecretId: 'test-secret-arn'
      });
    });

    test('should throw error when SecretString is missing', async () => {
      (mockSecretsManager.getSecretValue as jest.Mock).mockResolvedValueOnce({});

      await expect(dbInitializer.getCredentials('test-secret-arn'))
        .rejects
        .toThrow('Database credentials not found in secret');
    });

    test('should throw error when credentials are invalid', async () => {
      (mockSecretsManager.getSecretValue as jest.Mock).mockResolvedValueOnce({
        SecretString: JSON.stringify({ username: 'test-user' }) // missing password
      });

      await expect(dbInitializer.getCredentials('test-secret-arn'))
        .rejects
        .toThrow('Invalid secret format: missing required credentials');
    });
  });

  // Skip for now
  describe('initializeDatabase', () => {

    test('should execute all initialization queries', async () => {
      // Mock successful query responses for each query
      const mockSuccessResult = {
        rows: [],
        rowCount: 0,
        command: 'CREATE',
        oid: 0,
        fields: []
      } as QueryResult;

      // mockClient.query.mockResolvedValue(mockSuccessResult);

      await dbInitializer.initializeDatabase(testCredentials, true);

      // Get all calls to query
      const queryCalls = mockClient.query.mock.calls.map(call => call[0]);

      // Verify all required queries were executed
      expect(queryCalls).toEqual(
        expect.arrayContaining([
          expect.stringContaining('SET TIME ZONE'),
          expect.stringContaining('CREATE EXTENSION'),
          expect.stringContaining('CREATE TYPE user_status'),
          expect.stringContaining('CREATE TABLE IF NOT EXISTS users'),
          expect.stringContaining('CREATE INDEX'),
          expect.stringContaining('CREATE TRIGGER'),
          expect.stringContaining('ALTER TABLE users ENABLE ROW LEVEL SECURITY')
        ])
      );
      
      // Verify cleanup
      expect(mockClient.release).toHaveBeenCalled();
      expect(mockPool.end).toHaveBeenCalled();
    });

    // test('should handle database initialization errors', async () => {
    //   const testError = new Error('Database error');
    //   mockClient.query.mockRejectedValueOnce(testError);

    //   await expect(dbInitializer.initializeDatabase(testCredentials, true))
    //     .rejects
    //     .toThrow(testError);

    //   expect(mockClient.release).toHaveBeenCalled();
    //   expect(mockPool.end).toHaveBeenCalled();
    // });
  });

  describe('validateEnvironment', () => {
    test('should validate environment successfully', async () => {
      await expect(dbInitializer.validateEnvironment()).resolves.not.toThrow();
    });

    test('should throw error when DB_SECRET_ARN is missing', async () => {
      delete process.env.DB_SECRET_ARN;
      
      await expect(dbInitializer.validateEnvironment())
        .rejects
        .toThrow('DB_SECRET_ARN environment variable is required');
    });

    test('should throw error when host is missing', async () => {
      const invalidConfig = { ...testConfig, host: '' };
      const invalidInitializer = new DatabaseInitializer(mockSecretsManager, invalidConfig);
      
      await expect(invalidInitializer.validateEnvironment())
        .rejects
        .toThrow('Database host configuration is required');
    });

    test('should throw error when port is invalid', async () => {
      const invalidConfig = { ...testConfig, port: -1 };
      const invalidInitializer = new DatabaseInitializer(mockSecretsManager, invalidConfig);
      
      await expect(invalidInitializer.validateEnvironment())
        .rejects
        .toThrow('Invalid database port configuration');
    });
  });

  describe('Lambda Handler', () => {
    test('should handle successful initialization', async () => {
      const mockEvent: CloudFormationCustomResourceEvent = {
        RequestType: 'Create',
        ServiceToken: 'test-token',
        ResponseURL: 'test-url',
        StackId: 'test-stack',
        RequestId: 'test-request',
        LogicalResourceId: 'test-resource',
        ResourceType: 'test-type',
        ResourceProperties: {
          ServiceToken: 'test-service-token'
        }
      };

      (mockSecretsManager.getSecretValue as jest.Mock).mockResolvedValueOnce({
        SecretString: JSON.stringify({
          username: 'test-user',
          password: 'test-password'
        })
      });

      const response = await dbInitializer.createResponse(
        mockEvent,
        'SUCCESS',
        'Database initialization completed successfully'
      );

      expect(response).toEqual({
        RequestId: 'test-request',
        LogicalResourceId: 'test-resource',
        PhysicalResourceId: 'DBInitialization',
        StackId: 'test-stack',
        Status: 'SUCCESS',
        Reason: 'Database initialization completed successfully',
        NoEcho: false
      });
    });

    test('should handle initialization failure', async () => {
      const mockEvent: CloudFormationCustomResourceEvent = {
        RequestType: 'Create',
        ServiceToken: 'test-token',
        ResponseURL: 'test-url',
        StackId: 'test-stack',
        RequestId: 'test-request',
        LogicalResourceId: 'test-resource',
        ResourceType: 'test-type',
        ResourceProperties: {
          ServiceToken: 'test-service-token'
        }
      };

      const response = await dbInitializer.createResponse(
        mockEvent,
        'FAILED',
        'Database initialization failed: test error'
      );

      expect(response).toEqual({
        RequestId: 'test-request',
        LogicalResourceId: 'test-resource',
        PhysicalResourceId: 'DBInitialization',
        StackId: 'test-stack',
        Status: 'FAILED',
        Reason: 'Database initialization failed: test error',
        NoEcho: false
      });
    });
  });
});