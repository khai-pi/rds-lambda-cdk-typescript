import { SecretsManager, GetSecretValueCommandOutput } from '@aws-sdk/client-secrets-manager';

// Define the mock secret data with proper typing
const mockSecretData: GetSecretValueCommandOutput = {
  ARN: 'x',
  Name: 'test_creds',
  VersionId: 'x',
  SecretString: '{"username":"test","password":"password"}',
  VersionStages: ['x'],
  CreatedDate: new Date(),
  $metadata: {} // Required by AWS SDK v3
};

// Define interface for expected secret structure
interface SecretData {
  username: string;
  password: string;
}

// Mock the SecretsManager with proper typing
jest.mock('@aws-sdk/client-secrets-manager', () => {
  return {
    SecretsManager: jest.fn().mockImplementation(() => ({
      getSecretValue: jest.fn().mockImplementation(
        ({ SecretId }: { SecretId: string }): Promise<GetSecretValueCommandOutput> => {
          if (SecretId === 'test_creds') {
            return Promise.resolve(mockSecretData);
          } else {
            return Promise.reject(new Error('mock error'));
          }
        }
      )
    }))
  };
});

describe('Test secret manager', () => {
  describe('Given I have a valid secret name', () => {
    describe('When I send a request for test_creds', () => {
      it('return correct data', async () => {
        const mockReturnValue: SecretData = {
          username: 'test',
          password: 'password',
        };
        
        const secretManager = new SecretsManager({});
        const result = await secretManager.getSecretValue({ SecretId: 'test_creds' });
        const parsedSecret = JSON.parse(result.SecretString!) as SecretData;
        
        expect(parsedSecret).toEqual(mockReturnValue);
      });
    });

    describe('When I send a request without data', () => {
      it('Then an error is thrown.', async () => {
        const secretManager = new SecretsManager({});
        await expect(
          secretManager.getSecretValue({ SecretId: 'invalid_secret' })
        ).rejects.toThrow('mock error');
      });
    });
  });
});
