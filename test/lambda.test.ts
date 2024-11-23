import { APIGatewayProxyEvent, APIGatewayProxyResult, Context, Callback } from 'aws-lambda';
import { SecretsManager } from '@aws-sdk/client-secrets-manager';
import { createConnection, Connection, RowDataPacket } from 'mysql2/promise';
import { handler } from '../lambda/handler';

// Mock the AWS SDK and mysql2
jest.mock('@aws-sdk/client-secrets-manager');
jest.mock('mysql2/promise');

describe('Lambda Handler Tests', () => {
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
  });

  // Mock Lambda context
  const mockContext: Context = {
    callbackWaitsForEmptyEventLoop: true,
    functionName: 'test-function',
    functionVersion: '1',
    invokedFunctionArn: 'test-arn',
    memoryLimitInMB: '128',
    awsRequestId: 'test-request-id',
    logGroupName: 'test-log-group',
    logStreamName: 'test-log-stream',
    getRemainingTimeInMillis: () => 1000,
    done: () => {},
    fail: () => {},
    succeed: () => {},
  };

  // Mock callback
  const mockCallback: Callback<APIGatewayProxyResult> = jest.fn();

  // Mock event
  const mockEvent: APIGatewayProxyEvent = {
    queryStringParameters: {
      limit: '10',
      offset: '0'
    },
    body: null,
    headers: {},
    multiValueHeaders: {},
    httpMethod: 'GET',
    isBase64Encoded: false,
    path: '/users',
    pathParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    requestContext: {} as any,
    resource: ''
  };

  interface MockDbRow extends RowDataPacket {
    id: number;
    name: string;
  }

  const mockSecretValue = {
    username: 'testuser',
    password: 'testpass'
  };

  const mockDbRows: MockDbRow[] = [
    { id: 1, name: 'Test User 1' } as MockDbRow,
    { id: 2, name: 'Test User 2' } as MockDbRow
  ];

  const mockExecute = jest.fn().mockResolvedValue([mockDbRows]);
  const mockEnd = jest.fn().mockResolvedValue(undefined);
  
  (createConnection as jest.Mock).mockResolvedValue({
    execute: mockExecute,
    end: mockEnd
  } as Partial<Connection>);

  (SecretsManager.prototype.getSecretValue as jest.Mock).mockResolvedValue({
    SecretString: JSON.stringify(mockSecretValue)
  });

  test('successfully queries database with default parameters', async () => {
    const response = await handler(mockEvent, mockContext, mockCallback);

    if (!response) {
      throw new Error('Handler returned undefined');
    }

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      message: 'Success',
      data: mockDbRows,
      pagination: {
        limit: 10,
        offset: 0,
        nextOffset: 10
      }
    });

    expect(createConnection).toHaveBeenCalledWith({
      host: 'test-host',
      port: 3306,
      user: mockSecretValue.username,
      password: mockSecretValue.password,
      database: 'mydb',
      ssl: undefined
    });

    expect(mockExecute).toHaveBeenCalledWith(
      'SELECT * FROM users LIMIT ? OFFSET ?',
      [10, 0]
    );
  });

  test('handles missing environment variables', async () => {
    delete process.env.DB_HOST;

    const response = await handler(mockEvent, mockContext, mockCallback);
    
    if (!response) {
      throw new Error('Handler returned undefined');
    }

    expect(response.statusCode).toBe(500);
    expect(JSON.parse(response.body)).toEqual({
      message: 'Server configuration error',
      errorType: 'Error'
    });
  });

  test('handles database connection errors', async () => {
    (createConnection as jest.Mock).mockRejectedValue(
      new Error('ECONNREFUSED')
    );

    const response = await handler(mockEvent, mockContext, mockCallback);
    
    if (!response) {
      throw new Error('Handler returned undefined');
    }

    expect(response.statusCode).toBe(503);
    expect(JSON.parse(response.body)).toEqual({
      message: 'Database connection failed',
      errorType: 'Error'
    });
  });

  test('handles invalid pagination parameters', async () => {
    const eventWithInvalidParams: APIGatewayProxyEvent = {
      ...mockEvent,
      queryStringParameters: {
        limit: '1000',
        offset: '-5'
      }
    };

    const response = await handler(eventWithInvalidParams, mockContext, mockCallback);
    
    if (!response) {
      throw new Error('Handler returned undefined');
    }

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.pagination.limit).toBe(100);
    expect(body.pagination.offset).toBe(0);
  });

  test('handles callback style execution', (done) => {
    handler(mockEvent, mockContext, (error, result) => {
      expect(error).toBeNull();
      expect(result?.statusCode).toBe(200);
      done();
    });
  });

  test('closes database connection in case of error', async () => {
    mockExecute.mockRejectedValue(new Error('Query failed'));

    const response = await handler(mockEvent, mockContext, mockCallback);
    
    if (!response) {
      throw new Error('Handler returned undefined');
    }

    expect(response.statusCode).toBe(500);
    expect(mockEnd).toHaveBeenCalled();
  });

  test('sets callbackWaitsForEmptyEventLoop to false', async () => {
    await handler(mockEvent, mockContext, mockCallback);
    expect(mockContext.callbackWaitsForEmptyEventLoop).toBe(false);
  });
});