export interface ISecretValue {
    ARN: string;
    CreatedDate: string;
    Name: string;
    SecretBinary: any;
    SecretString: string;
    VersionId: string;
    VersionStages: string[];
    ResultMetadata: any;
}

/**
 * An access to the "In Memmory AWS Parameters and Secrets Lambda Extension"
 * Reference: https://docs.aws.amazon.com/systems-manager/latest/userguide/ps-integration-lambda-extensions.html
 * 
 * TODO: Use the aws-sdk instead ?
 */
export class InMemoryCacheExtension {

    /** Send an http request to the "Parameters and Secret extension" */
    private static request(endpoint: string): Promise<Response> {
        const port = process.env.PARAMETERS_SECRETS_EXTENSION_HTTP_PORT || 2773;
        const url = `http://localhost:${port}/${endpoint}`;
        const sessionToken = process.env.AWS_SESSION_TOKEN as string;
        return fetch(url, { headers: { 'X-AWS-Parameters-Secrets-Token': sessionToken } })
    }

    /** Get Secret Value */
    public static async getSecretValue(secretArn: string): Promise<ISecretValue> {
        console.log(`Fetching secret "${secretArn}" from extension...`)
        const res = await this.request(`secretsmanager/get?secretId=${secretArn}`);
        return res.json();
    }
}