import { APIGatewayProxyEvent } from 'aws-lambda';
import { GetSecretValueCommandOutput, SecretsManager } from '@aws-sdk/client-secrets-manager';
import { Pool, QueryResult } from 'pg';
import { handler } from '../lambda/handler';

const mockSecretData: GetSecretValueCommandOutput = {
  ARN: 'test-secret-arn',
  Name: 'test_creds',
  VersionId: 'x',
  SecretString: '{"username":"test","password":"password"}',
  VersionStages: ['x'],
  CreatedDate: new Date(),
  $metadata: {}
};

// Mock SecretsManager with correct error handling
jest.mock('@aws-sdk/client-secrets-manager', () => {
  return {
    SecretsManager: jest.fn(() => ({
      getSecretValue: jest.fn().mockResolvedValue(mockSecretData)
  })
  )};
});
// Mock modules
jest.mock('pg', () => ({
  Pool: jest.fn()
}));

// Mock environment variables
process.env.DB_SECRET_ARN = 'test-secret-arn';
process.env.DB_HOST = 'test-host';
process.env.DB_PORT = '5432';
process.env.DB_NAME = 'test-db';

describe('Lambda Handler Tests', () => {
  let mockPool: jest.Mocked<{
    query: jest.Mock;
    end: jest.Mock;
  }>;
  let mockQuery: jest.MockedFunction<() => Promise<QueryResult<any>>>;
  let mockSecretsManager: jest.Mocked<SecretsManager>;

  beforeEach(() => {
    // Clear all mocks
    jest.clearAllMocks();

    // Mock SecretsManager
    mockSecretsManager = new SecretsManager() as jest.Mocked<SecretsManager>;
    mockSecretsManager.getSecretValue = jest.fn().mockResolvedValue({
      SecretString: JSON.stringify({
        username: 'test-user',
        password: 'test-password'
      })
    });
    (SecretsManager as jest.Mock).mockImplementation(() => mockSecretsManager);

    // Mock Pool
    mockPool = {
      query: jest.fn(),
      end: jest.fn()
    };
    (Pool as unknown as jest.Mock).mockImplementation(() => mockPool);

    // mockQuery = jest.fn().mockResolvedValue({
    //   rows: [],
    //   rowCount: 0,
    //   command: '',
    //   oid: 0,
    //   fields: []
    // });

  });

  describe('GET requests', () => {
    it('should handle successful GET request', async () => {
      // Mock the database query response
      const mockTimestamp = new Date().toISOString();
      mockPool.query.mockResolvedValueOnce({
        rows: [{ now: mockTimestamp }],
        command: 'SELECT',
        rowCount: 1,
        oid: 0,
        fields: []
      });

      // Create mock event
      const event: APIGatewayProxyEvent = {
        httpMethod: 'GET',
        body: null,
        headers: {},
        isBase64Encoded: false,
        multiValueHeaders: {},
        multiValueQueryStringParameters: null,
        path: '/',
        pathParameters: null,
        queryStringParameters: null,
        requestContext: {} as any,
        resource: '',
        stageVariables: null
      };

      // Execute handler
      const response = await handler(event);

      // Assertions
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual({
        message: 'Database connection successful',
        timestamp: mockTimestamp
      });
      expect(mockPool.query).toHaveBeenCalledWith('SELECT NOW()');
    });

    it('should handle database query error', async () => {
      // Mock database error
      const secretsError = new Error('Database error');
      mockSecretsManager.getSecretValue = jest.fn().mockImplementation(() => {
        throw secretsError;
      });

      const event: Partial<APIGatewayProxyEvent> = {
        httpMethod: 'GET',
      };

      const response = await handler(event as APIGatewayProxyEvent);

      expect(response.statusCode).toBe(500);
      expect(JSON.parse(response.body)).toEqual({
        message: 'Internal server error',
        error: 'Database error'
      });
    });
  });

  describe('POST requests', () => {
    it('should handle successful POST request with body', async () => {
      const testBody = { test: 'data' };
      const event: Partial<APIGatewayProxyEvent> = {
        httpMethod: 'POST',
        body: JSON.stringify(testBody)
      };

      const response = await handler(event as APIGatewayProxyEvent);

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual({
        message: 'POST request successful',
        body: testBody
      });
    });

    it('should handle POST request with empty body', async () => {
      const event: Partial<APIGatewayProxyEvent> = {
        httpMethod: 'POST',
        body: null
      };

      const response = await handler(event as APIGatewayProxyEvent);

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual({
        message: 'POST request successful',
        body: {}
      });
    });
  });

  describe('Error handling', () => {
    it('should handle unsupported HTTP methods', async () => {
      const event: Partial<APIGatewayProxyEvent> = {
        httpMethod: 'PUT'
      };

      const response = await handler(event as APIGatewayProxyEvent);

      expect(response.statusCode).toBe(405);
      expect(JSON.parse(response.body)).toEqual({
        message: 'Method not allowed'
      });
    });

    it('should handle secrets manager error', async () => {
      const secretsError = new Error('Secrets manager error');
      mockSecretsManager.getSecretValue = jest.fn().mockImplementation(() => {
        throw secretsError;
      });

      const event: Partial<APIGatewayProxyEvent> = {
        httpMethod: 'GET'
      };

      const response = await handler(event as APIGatewayProxyEvent);

      expect(response.statusCode).toBe(500);
      expect(JSON.parse(response.body)).toEqual({
        message: 'Internal server error',
        error: 'Secrets manager error'
      });
    });
  });
});