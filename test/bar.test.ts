import { SecretsManager, GetSecretValueCommandOutput } from '@aws-sdk/client-secrets-manager';
import { Pool } from 'pg';
import { APIGatewayProxyEvent } from 'aws-lambda';
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

// Mock modules
jest.mock('pg', () => ({
  Pool: jest.fn()
}));

// Mock SecretsManager with correct error handling
jest.mock('@aws-sdk/client-secrets-manager', () => {
  return {
    SecretsManager: jest.fn(() => ({
      getSecretValue: jest.fn().mockResolvedValue(mockSecretData)
  })
  )};
});

describe('lambda test', () => {
  let mockPool: jest.Mocked<{
    query: jest.Mock;
    end: jest.Mock;
  }>;

  beforeEach(() => {
    jest.clearAllMocks();

    mockPool = {
      query: jest.fn(),
      end: jest.fn()
    };

    (Pool as unknown as jest.Mock).mockImplementation(() => mockPool);

    // Set environment variables
    process.env.DB_SECRET_ARN = 'test-secret-arn';
    process.env.DB_HOST = 'test-host';
    process.env.DB_PORT = '5432';
    process.env.DB_NAME = 'test-db';
  });

  describe('GET requests', () => {
    it('should handle successful GET request', async () => {
      const mockTimestamp = new Date().toISOString();
      
      // Mock successful query response
      mockPool.query.mockResolvedValueOnce({
        rows: [{ now: mockTimestamp }],
        rowCount: 1,
        command: 'SELECT',
        oid: null,
        fields: []
      });
      mockPool.end.mockResolvedValueOnce(undefined);

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

      const response = await handler(event);

      // Verify response
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual({
        message: 'Database connection successful',
        timestamp: mockTimestamp
      });
      expect(mockPool.query).toHaveBeenCalledWith('SELECT NOW()');
      expect(mockPool.end).toHaveBeenCalled();
    });

  });

  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });
});