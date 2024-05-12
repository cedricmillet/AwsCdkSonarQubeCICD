import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecsp from 'aws-cdk-lib/aws-ecs-patterns';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as triggers from 'aws-cdk-lib/triggers';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cr from 'aws-cdk-lib/custom-resources';
import { BuildEnvironmentVariableType, BuildSpec, ComputeType, LinuxBuildImage, Project, Source } from 'aws-cdk-lib/aws-codebuild';
import { Code, Repository } from 'aws-cdk-lib/aws-codecommit';
import { CfnEIP, IVpc, InstanceClass, InstanceSize, InstanceType, IpAddresses, NatProvider, Peer, Port, SecurityGroup, SubnetType, Vpc } from 'aws-cdk-lib/aws-ec2';
import { EventField, Rule, RuleTargetInput } from 'aws-cdk-lib/aws-events';
import { CodeBuildProject } from 'aws-cdk-lib/aws-events-targets';
import { Effect, ManagedPolicy, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { AuroraPostgresEngineVersion, ClusterInstance, Credentials, DatabaseCluster, DatabaseClusterEngine } from 'aws-cdk-lib/aws-rds';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import path = require('path');
import { ApplicationLoadBalancer } from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';

//                pullRequestUpdated                                                      
//                pullRequestCreated                                                      
// ┌─────────────┐          ┌────────────┐                                                
// │ CODE COMMIT ├─────────►│ CLOUDWATCH │                               ┌───────────────┐
// └─────────────┘          │    EVENT   │                               │    AURORA     │
//         ▲                └──────┬─────┘                               │   DATABASE    │
//         │                       │                                     └───────────────┘
//         │                       │                                             ▲        
//         │                       ▼                                             │        
//         │                ┌─────────────┐        ┌──────────────┐      ┌───────┴───────┐
//         └────────────────┤  CODEBUILD  ├───────►│ ELASTIC LOAD ├─────►│ ECS CONTAINER │
//       Add PR comments    │   PROJECT   │        │   BALANCER   │      │   SONARQUBE   │
//                          └─────────────┘        └──────────────┘      └───────────────┘
//                                                         ▲                              
//                                                         │                              
//                                                         │                              
//                                                 ┌───────┴──────┐                       
//                                                 │  ONBOARDING  │                       
//                                                 │    LAMBDA    │                       
//                                                 └──────────────┘                       
export class CdkSonarqubeDemoStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const { region, account } = cdk.Stack.of(this);
    const DB_NAME = `sonarqube`;
    const DB_PORT = 5432;
    const SONAR_LISTENING_PORT = 9000;

    // Network stuff: VPC, subnet, security group, route table...
    const eip = new CfnEIP(this, `${id}ElasticIp`);
    const vpc = new Vpc(this, `${id}Vpc`, {
      vpcName: `${id}Vpc`,
      natGatewayProvider: NatProvider.gateway({ eipAllocationIds: [eip.attrAllocationId] }),
      natGateways: 1
    });

    /**
     * This Security Group contains : 
     * - ALB (Application Load Balancer)
     * - ECS (Elastic Container Service)
     * - The onboarding Lambda : used to change the default sonarqube admin credentials
     * - CodeBuild Project
     */
    const sonarSecurityGroup = new SecurityGroup(this, `${id}SonarSecurityGroup`, {
      securityGroupName: `${id}SonarSecurityGroup`,
      description: 'Contains ECS cluster + ALB + Lambda + codebuild project',
      vpc,
      allowAllOutbound: true
    });

    /** The Aurora Database Security Group */
    const dbSecurityGroup = new SecurityGroup(this, `${id}DBSecurityGroup`, {
      securityGroupName: `${id}DBSecurityGroup`,
      description: 'Embeds Aurora RDS',
      vpc,
      allowAllOutbound: true
    });

    // Allow SONAR -> DATABASE (TCP/5432)
    dbSecurityGroup.addIngressRule(sonarSecurityGroup, Port.tcp(DB_PORT), `Allow AuroraDB connection from sonar security group`);
    // Allow LOADBALANCER -> SONAR (TCP/9000)
    sonarSecurityGroup.addIngressRule(sonarSecurityGroup, Port.tcp(SONAR_LISTENING_PORT), 'Allow connection to sonarqube server');
    // Allow LAMBDA -> LOAD BALANCER (TCP/80)
    sonarSecurityGroup.addIngressRule(Peer.ipv4(eip.attrPublicIp + "/32"), Port.tcp(80), "Elastic IP - public IPv4Pool");

    // Create aurora-postgres cluster
    const dbCluster = new DatabaseCluster(this, `${id}DatabaseCLuster`, {
      engine: DatabaseClusterEngine.auroraPostgres({ version: AuroraPostgresEngineVersion.VER_15_5 }),
      defaultDatabaseName: DB_NAME,
      writer: ClusterInstance.provisioned(`${id}DbProvisionedWriter`, {
        instanceType: InstanceType.of(InstanceClass.T3, InstanceSize.MEDIUM)
      }),
      securityGroups: [dbSecurityGroup],
      credentials: Credentials.fromGeneratedSecret("dbClusterUsername"),
      port: DB_PORT,
      vpc
    });

    const sonarCluster = new ecs.Cluster(this, `${id}ECSCluster`, { vpc });

    // A set of specific requirements for the embedded Elastic Search
    // https://docs.sonarsource.com/sonarqube/10.0/requirements/prerequisites-and-overview/
    sonarCluster.autoscalingGroup?.addUserData(
      `sysctl -w vm.max_map_count=524288`,
      `sysctl -w fs.file-max=131072`,
      `ulimit -n 131072`,
      `ulimit -u 8192`
    );

    const loadBalancer = new ApplicationLoadBalancer(this, `${id}LoadBalancer`, {
      vpc,
      internetFacing: true, /** Whether the load balancer has an internet-routable address */
      securityGroup: sonarSecurityGroup,
    });

    // Allow ECS task to read database secret
    const ecsTaskRole = new Role(this, `${id}TaskRole`, {
      roleName: `${id}TaskRole`,
      assumedBy: new ServicePrincipal(`ecs-tasks.amazonaws.com`),
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName("service-role/AmazonECSTaskExecutionRolePolicy")
      ]
    });
    dbCluster.secret?.grantRead(ecsTaskRole);

    const sonarSvc = new ecsp.ApplicationLoadBalancedFargateService(this, `${id}SonarQubeServer`, {
      cluster: sonarCluster,
      desiredCount: 1,
      securityGroups: [sonarSecurityGroup],
      taskImageOptions: {
        image: ecs.ContainerImage.fromRegistry('sonarqube:lts-community'), // TODO: use private image from ECR ?
        containerPort: SONAR_LISTENING_PORT,
        environment: {
          "SONAR_CE_JAVAOPTS": "-Xmx1G -Xms1G -XX:+HeapDumpOnOutOfMemoryError", // Prevent "Java heap space" error in large projects
          "SONAR_LOG_LEVEL": "DEBUG",
          "SONAR_JDBC_URL": `jdbc:postgresql://${dbCluster.clusterEndpoint.socketAddress}/${DB_NAME}`,
          "SONAR_WEB_PORT": `${SONAR_LISTENING_PORT}`,
          "ES_SETTING_NODE_STORE_ALLOW__MMAP": "false",
        },
        secrets: {
          // List of secrets to expose to the container as environment variables
          "SONAR_JDBC_USERNAME": ecs.Secret.fromSecretsManager(dbCluster.secret as Secret, "username"),
          "SONAR_JDBC_PASSWORD": ecs.Secret.fromSecretsManager(dbCluster.secret as Secret, "password")
        },
        taskRole: ecsTaskRole,
        command: ["-Dsonar.search.javaAdditionalOpts=-Dnode.store.allow_mmap=false"] // https://github.com/SonarSource/docker-sonarqube/issues/282
      },
      loadBalancer,
      openListener: false,  // Prevent creation of public inbound rule in load balancer security group (0.0.0.0 TCP/80)
      memoryLimitMiB: 4096, // Default: 512 (in MiB)
      cpu: 1024,            // Default: 256
    });

    sonarSvc.taskDefinition.defaultContainer?.addUlimits({
      name: ecs.UlimitName.NOFILE,
      softLimit: 65536,
      hardLimit: 65536
    });

    // Add DB Cluster as dependency.
    // E.g. wait for DB created before app starting
    sonarSvc.node.addDependency(dbCluster);

    const sonarAdminSecret = new Secret(this, `${id}AdmSecret`, {
      secretName: `${id}AdmSecret`,
    });

    //  Create pull request approver service account
    const sonarServiceAccountSecret = new Secret(
      this,
      `${id}PullRequestValidatorSecret`,
      {
        secretName: `${id}SonarSASecret`,
        generateSecretString: {
          secretStringTemplate: JSON.stringify({
            username: "sonarSVCAUSername",
            name: "Sonar Service Account"
          }),
          generateStringKey: 'password',
          excludePunctuation: true,
          passwordLength: 10
        }
      }
    );

    const lambdaRole = new Role(this, `${id}LambdaRole`, {
      assumedBy: new iam.ServicePrincipal(`lambda.amazonaws.com`),
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaVPCAccessExecutionRole"), // Lambda in vpc need this role
        ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole")
      ]
    });

    // Code commit repository
    const repository = new Repository(this, `${id}DemoRepository`, {
      repositoryName: 'DemoRepository',
      description: 'Repository description',
      code: Code.fromDirectory(path.join(__dirname, 'code'), 'main')
    });

    // Create code build role (allowed to post comments and approve PRs)
    const codeBuildRole = new Role(this, `${id}CodeBuildRole`, {
      assumedBy: new ServicePrincipal('codebuild.amazonaws.com')
    });
    sonarServiceAccountSecret.grantRead(codeBuildRole);

    codeBuildRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          'codecommit:UpdatePullRequestApprovalState',
          'codecommit:PostCommentForPullRequest'
        ],
        resources: ['*']
      })
    );

    // Create codebuild project
    const project = new Project(this, `${id}Project`, {
      vpc,
      securityGroups: [sonarSecurityGroup],
      badge: true, // TODO: add in README.md
      source: Source.codeCommit({
        identifier: `${id}Repository`,
        repository: repository
        //branchOrRef: "development"
      }),
      projectName: `${id}SonarQubeAnalyzeProject`,
      description: 'Project description',
      buildSpec: BuildSpec.fromSourceFilename('buildspec.yml'),
      environment: {
        buildImage: LinuxBuildImage.fromCodeBuildImageId(
          `aws/codebuild/amazonlinux2-x86_64-standard:corretto11`
        ),
        computeType: ComputeType.MEDIUM
      },
      environmentVariables: {
        SONARQUBE_USER_SECRET_NAME: {
          type: BuildEnvironmentVariableType.PLAINTEXT,
          value: sonarServiceAccountSecret.secretName
        },
        SONARQUBE_HOST_URL: {
          type: BuildEnvironmentVariableType.PLAINTEXT,
          value: `http://${sonarSvc.loadBalancer.loadBalancerDnsName}`
        }
      },
      role: codeBuildRole
    });

    const ruleTargetInput = RuleTargetInput.fromObject({
      sourceVersion: EventField.fromPath('$.detail.sourceCommit'),
      artifactsOverride: { type: 'NO_ARTIFACTS' },
      environmentVariablesOverride: [
        {
          name: 'PULL_REQUEST_ID',
          value: EventField.fromPath('$.detail.pullRequestId'),
          type: 'PLAINTEXT'
        },
        {
          name: 'REPOSITORY_NAME',
          value: EventField.fromPath('$.detail.repositoryNames[0]'),
          type: 'PLAINTEXT'
        },
        {
          name: 'SOURCE_COMMIT',
          value: EventField.fromPath('$.detail.sourceCommit'),
          type: 'PLAINTEXT'
        },
        {
          name: 'DESTINATION_COMMIT',
          value: EventField.fromPath('$.detail.destinationCommit'),
          type: 'PLAINTEXT'
        },
        {
          name: 'REVISION_ID',
          value: EventField.fromPath('$.detail.revisionId'),
          type: 'PLAINTEXT'
        }
      ]
    });

    // Create cloudwatch event rule
    // When a PR is created or updated, a new CodeBuild build is instanciated
    const rule = new Rule(this, `${id}CloudWatchEventRule`, {
      enabled: true,
      eventPattern: {
        source: ['aws.codecommit'],
        resources: [repository.repositoryArn],
        detail: {
          event: ['pullRequestCreated', 'pullRequestSourceBranchUpdated']
          //destinationReference: 'refs/heads/main' // optional...
        }
      }
    });
    rule.addTarget(new CodeBuildProject(project, { event: ruleTargetInput }));

    repository.grant(project, 'codecommit:PostCommentReply');
    repository.grant(project, 'codecommit:PostCommentForPullRequest');
    repository.grant(project, 'codecommit:UpdatePullRequestApprovalState');

    const lambdaFunction = new NodejsFunction(this, `${id}SonarOnboardingFunction`, {
      vpc,
      securityGroups: [sonarSecurityGroup],
      functionName: `${id}SonarOnboardingFunction`,
      entry: 'lambda/sonarqubeOnboarding.lambda.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(900),
      retryAttempts: 0,
      role: lambdaRole,
      environment: {
        // TODO: Adds certificate if sonar is publicly exposed (HTTPS)
        SONAR_URL: "http://" + sonarSvc.loadBalancer.loadBalancerDnsName,
        SONAR_ADMIN_SECRET_ARN: sonarAdminSecret.secretArn,
        SONAR_SERVICE_ACCOUNT_SECRET_ARN: sonarServiceAccountSecret.secretArn
      },
    });
    sonarAdminSecret.grantRead(lambdaFunction);
    sonarServiceAccountSecret.grantRead(lambdaFunction);

    const parametersAndSecretsExtension = lambda.LayerVersion.fromLayerVersionArn(
      this,
      'ParametersAndSecretsLambdaExtension',
      // Refer to this table to find the correct lambda extension arn :
      // https://docs.aws.amazon.com/systems-manager/latest/userguide/ps-integration-lambda-extensions.html#intel
      'arn:aws:lambda:eu-west-3:780235371811:layer:AWS-Parameters-and-Secrets-Lambda-Extension:11',
    )
    lambdaFunction.addLayers(parametersAndSecretsExtension);

    const lambdaTrigger = new cr.AwsCustomResource(this, `${id}StatefunctionTrigger`, {
      policy: cr.AwsCustomResourcePolicy.fromStatements([new iam.PolicyStatement({
        actions: ['lambda:InvokeFunction'],
        effect: iam.Effect.ALLOW,
        resources: [lambdaFunction.functionArn]
      })]),
      timeout: cdk.Duration.minutes(15),
      onCreate: {
        service: 'Lambda',
        action: 'invoke',
        parameters: {
          FunctionName: lambdaFunction.functionName,
          InvocationType: triggers.InvocationType.EVENT /** Asynchronous triggering */
        },
        physicalResourceId: cr.PhysicalResourceId.of(`${id}LambdaTriggerPhysicalId`)
      }
    })
    lambdaTrigger.node.addDependency(sonarSvc);
  }

}
