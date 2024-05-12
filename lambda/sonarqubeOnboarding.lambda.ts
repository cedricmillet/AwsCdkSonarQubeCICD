import { Context, APIGatewayProxyResult, APIGatewayEvent } from 'aws-lambda';
import { SonarQubeClient, SonarQubeClientOptions } from './lib/SonarQubeClient';
import { InMemoryCacheExtension } from './lib/InMemoryCacheExtension';


/**
 * SONARQUBE ONBOARDING LAMBDA
 * 
 * This lambda is intended to be triggered once and designed to :
 * - change the default admin:admin account password
 * - create a sonar "service account" -> we'll use this account in codebuild.
 */

/** Wait x seconds */
const wait = async (x: number) => new Promise((res, _) => setTimeout(() => res(true), x * 1000));

const [SONAR_URL, SONAR_ADMIN_SECRET_ARN, SONAR_SERVICE_ACCOUNT_SECRET_ARN] = [
    process.env.SONAR_URL || "localhost",
    /** ARN of the secret containing credentials of the sonar admin account */
    process.env.SONAR_ADMIN_SECRET_ARN || "",
    /** ARN of the secret containing credentials of the sonar service account */
    process.env.SONAR_SERVICE_ACCOUNT_SECRET_ARN || ""
];

export const handler = async (event: APIGatewayEvent, context: Context): Promise<APIGatewayProxyResult> => {
    console.log(`--------------- STARTING ONBOARDING LAMBDA ---------------`);
    console.log(`Starting at `, new Date())
    console.log(`Event: ${JSON.stringify(event, null, 2)}`);
    console.log(`Context: ${JSON.stringify(context, null, 2)}`);
    console.log("SONAR_URL:", SONAR_URL);
    console.log("SONAR_ADMIN_SECRET_ARN:", SONAR_ADMIN_SECRET_ARN);

    if (SONAR_ADMIN_SECRET_ARN.length === 0) {
        throw new Error(`Missing environment variable : ${SONAR_ADMIN_SECRET_ARN}`);
    } else if (SONAR_SERVICE_ACCOUNT_SECRET_ARN.length === 0) {
        throw new Error(`Missing environment variable : ${SONAR_SERVICE_ACCOUNT_SECRET_ARN}`);
    }

    const sonarOptions: SonarQubeClientOptions = {
        url: SONAR_URL,
        username: SonarQubeClient.DEFAULT_USERNAME,
        password: SonarQubeClient.DEFAULT_PASSWORD
    };
    const client = new SonarQubeClient(sonarOptions);

    // STEP 1 - Wait for sonarqube ready
    const retryDelay = 15; // Seconds
    while (!await client.systemHealth()) {
        console.warn(`Unhealthy sonarqube system. Waiting ${retryDelay} seconds before next try.`)
        await wait(retryDelay);
    }
    console.log(`1/3 - System ready. Let's update admin credentials !`);

    const adminSecretValue = await InMemoryCacheExtension.getSecretValue(SONAR_ADMIN_SECRET_ARN);
    const newAdminSonarPassword = adminSecretValue.SecretString;

    // STEP 2 - Create service account
    console.log(`2/3 - Create service account`);
    const serviceSecretValue = await InMemoryCacheExtension.getSecretValue(SONAR_SERVICE_ACCOUNT_SECRET_ARN);
    const { username, password, name } = JSON.parse(serviceSecretValue.SecretString) as { password: string, username: string, name: string };
    console.log(`Creating Service Account "${name}" (username=${username} / pwd=${password})`)
    const serviceAccountCreated = await client.createUser(username, password, name);


    // STEP 3 - Change default admin password if necessary
    console.log(`3/3 - Updating admin password: `, newAdminSonarPassword);
    const adminPwdUpdated = await client.changePassword(SonarQubeClient.DEFAULT_USERNAME, SonarQubeClient.DEFAULT_PASSWORD, newAdminSonarPassword);
    console.log(`-> Password up to date.`)


    const success = serviceAccountCreated && adminPwdUpdated;
    return {
        statusCode: success ? 200 : 500,
        body: JSON.stringify({
            message: success ? "OK" : "AN ERROR OCCURED",
            adminAccount: {
                success: adminPwdUpdated,
                username: SonarQubeClient.DEFAULT_USERNAME,
                password: newAdminSonarPassword
            },
            serviceAccount: {
                success: serviceAccountCreated,
                username,
                password,
                name
            }
        })
    };
};