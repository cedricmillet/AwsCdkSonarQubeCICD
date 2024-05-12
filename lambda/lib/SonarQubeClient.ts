/**
 * Used by lambda functions to communicate with SonarQube API.
 * Reference: https://next.sonarqube.com/sonarqube/web_api
 * 
 * /!\ Elastic IP (public ipv4) associated with NAT gateway of the
 *     subnet containing the lambda needs to be added as ingress rule
 *     in the security group containing the Elastic Container Service :
 *     
 *      IPv4	HTTP	TCP	80	<ELASTIC_IP>/32
 *      IPv4	HTTPS	TCP	443	<ELASTIC_IP>/32
 * 
 * Why not use an existing client library to communicate with Sonar API ? 
 * ==> For optimization purposes, with an external node dependency :
 * - Lambda cold start is increased
 * - CPU, memory... and then deployment cost
 * ==> For security purposes
 * - you need to track and look for app vulnerabilities, and because deployed tool is intended
 *   to qualify code of critical products and a CVE can be easily introduced in an npm package :
 *   we need a ZERO-PUBLIC-CVE insurance.
 * ==> But mainly because public and available npm sonar client packages are bad, deprecated /
 *      not maintained and import a set of useless transitive dependencies...
 */
export class SonarQubeClient {

    public static DEFAULT_USERNAME = "admin";
    public static DEFAULT_PASSWORD = "admin";

    private opts: SonarQubeClientOptions;

    public constructor(options: SonarQubeClientOptions) {
        this.opts = options;
    }

    /** Healthcheck */
    public async systemHealth(): Promise<boolean> {
        return new Promise((resolve, _) => {
            this.get(`api/system/health`).then((r) => {
                resolve(r.status === 200 && r.body.health === "GREEN");
            }).catch(err => {
                resolve(false);
            })
        });
    }

    /** Change a specific user's password */
    public async changePassword(username: string, oldPwd: string, newPwd: string): Promise<boolean> {
        return new Promise((resolve, _) => {
            const payload = new URLSearchParams();
            payload.append('login', username);
            payload.append('password', newPwd);
            payload.append('previousPassword', oldPwd);

            this.post(`api/users/change_password`, payload).then((r) => {
                const success = r.status === 204;
                if (success && this.opts.username === username) this.opts.password = newPwd;
                resolve(success);
            });
        });
    }

    /** Create a new user (with default role) */
    public async createUser(username: string, password: string, name: string): Promise<boolean> {
        return new Promise((resolve, _) => {
            const payload = new URLSearchParams();
            payload.append('login', username);
            payload.append('password', password);
            payload.append('name', name);
            this.post(`api/users/create`, payload).then(r => resolve(r.status === 200));
        });
    }

    private getDefaultHeaders() {
        const base64Creds = Buffer.from(this.opts.username + ":" + this.opts.password).toString('base64');
        return { Authorization: `Basic ${base64Creds}` };
    }

    private get = (endpoint: string) => this.request(endpoint, "GET", null);

    private post = (endpoint: string, body: any) => this.request(endpoint, "POST", body);

    private request(endpoint: string, method: string, body: any): Promise<{ status: number, body: any }> {
        return new Promise((resolve, reject) => {
            const url = `${this.opts.url}/${endpoint}`;
            console.log(`[REQUEST][${method}] - ${url} - body=`, body)
            fetch(url, {
                method,
                ...(body && { body }),
                headers: {
                    ...this.getDefaultHeaders()
                },
            }).then(async (res) => {
                const [status, body] = [res.status, res.body !== null ? await res.json() : null];
                console.log(`[RESPONSE] :: status=${status} / json=`, body)
                resolve({ status, body });
            }).catch(err => {
                console.error(`[RESPONSE][ERROR] :: An error occured : `);
                console.error(err);
                reject(err);
            });
        })
    }
}

export interface SonarQubeClientOptions {
    url: string;
    username: string;
    password: string;
}