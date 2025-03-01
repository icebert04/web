import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";

// The following vars ar not alloed to be undefined, hence the `${...}` magic
let dbUsername = `${process.env["POC_DB_USER"]}`;
let dbPassword = pulumi.secret(`${process.env["POC_DB_PASSWORD"]}`);
let dbName = `${process.env["POC_DB_NAME"]}`;

let githubApiUser = `${process.env["POC_GITHUB_API_USER"]}`;
let githubApiToken = pulumi.secret(`${process.env["POC_GITHUB_API_TOKEN"]}`);
let githubClientId = `${process.env["POC_GITHUB_CLIENT_ID"]}`;
let githubClientSecret = pulumi.secret(`${process.env["POC_GITHUB_CLIENT_SECRET"]}`);
let githubAppName = `${process.env["POC_GITHUB_APP_NAME"]}`;


export const dockerGtcWebImage = `${process.env["POC_DOCKER_GTC_WEB_IMAGE"]}`;


//////////////////////////////////////////////////////////////
// Create permissions:
//  - user for logging
//////////////////////////////////////////////////////////////

const usrLogger = new aws.iam.User("usrLogger", {
    path: "/review/",
});
// const usrStatic = new aws.iam.User("usrStatic", {
//     path: "/review/",
// });

const usrLoggerAccessKey = new aws.iam.AccessKey("usrLoggerAccessKey", { user: usrLogger.name });
// const usrStaticAccessKey = new aws.iam.AccessKey("usrStaticAccessKey", {user: usrStatic.name});

export const usrLoggerKey = usrLoggerAccessKey.id;
export const usrLoggerSecret = usrLoggerAccessKey.secret;
// export const usrStaticKey = usrStaticAccessKey.id;
// export const usrStaticSecret = usrStaticAccessKey.secret;


// See https://pypi.org/project/watchtower/ for the polciy required
const test_attach = new aws.iam.PolicyAttachment("CloudWatchPolicyAttach", {
    users: [usrLogger.name],
    roles: [],
    groups: [],
    policyArn: "arn:aws:iam::aws:policy/AWSOpsWorksCloudWatchLogs",
});


//////////////////////////////////////////////////////////////
// Create bucket for static hosting
// Check policy recomendation here: https://django-storages.readthedocs.io/en/latest/backends/amazon-S3.html#iam-policy
//////////////////////////////////////////////////////////////

const staticAssetsBucket = new aws.s3.Bucket("bucket", {
    acl: "public-read",
    website: {
        indexDocument: "index.html",
    },
    forceDestroy: true,
});

const staticAssetsBucketPolicyDocument = aws.iam.getPolicyDocumentOutput({
    statements: [{
        principals: [{
            type: "AWS",
            identifiers: [pulumi.interpolate`${usrLogger.arn}`],
        }],
        actions: [
            "s3:PutObject",
            "s3:GetObjectAcl",
            "s3:GetObject",
            "s3:ListBucket",
            "s3:DeleteObject",
            "s3:PutObjectAcl"
        ],
        resources: [
            staticAssetsBucket.arn,
            pulumi.interpolate`${staticAssetsBucket.arn}/*`,
        ],
    }],
});

const staticAssetsBucketPolicy = new aws.s3.BucketPolicy("staticAssetsBucketPolicy", {
    bucket: staticAssetsBucket.id,
    policy: staticAssetsBucketPolicyDocument.apply(staticAssetsBucketPolicyDocument => staticAssetsBucketPolicyDocument.json),
});

export const bucketName = staticAssetsBucket.id;
export const bucketArn = staticAssetsBucket.arn;
export const bucketWebURL = pulumi.interpolate`http://${staticAssetsBucket.websiteEndpoint}/`;

//////////////////////////////////////////////////////////////
// Set up VPC
//////////////////////////////////////////////////////////////

const vpc = new awsx.ec2.Vpc("gitcoin", {
    subnets: [
        { type: "public", },
        { type: "private", mapPublicIpOnLaunch: true },
    ],
});

export const vpcID = vpc.id;
export const vpcPrivateSubnetIds = vpc.privateSubnetIds;
export const vpcPublicSubnetIds = vpc.publicSubnetIds;


export const vpcPublicSubnet1 = vpcPublicSubnetIds.then((subnets) => {
    return subnets[0];
});


//////////////////////////////////////////////////////////////
// Set up RDS instance
//////////////////////////////////////////////////////////////
let dbSubnetGroup = new aws.rds.SubnetGroup("rds-subnet-group", {
    subnetIds: vpcPrivateSubnetIds
});

const db_secgrp = new aws.ec2.SecurityGroup("db_secgrp", {
    description: "Security Group for DB",
    vpcId: vpc.id,
    ingress: [
        { protocol: "tcp", fromPort: 5432, toPort: 5432, cidrBlocks: ["0.0.0.0/0"] },
    ],
    egress: [{
        protocol: "-1",
        fromPort: 0,
        toPort: 0,
        cidrBlocks: ["0.0.0.0/0"],
    }],
});

// TODO: enable delete protection for the DB
const postgresql = new aws.rds.Instance("gitcoin-database", {
    allocatedStorage: 10,
    engine: "postgres",
    // engineVersion: "5.7",
    instanceClass: "db.t3.micro",
    name: dbName,
    password: dbPassword,
    username: dbUsername,
    skipFinalSnapshot: true,
    dbSubnetGroupName: dbSubnetGroup.id,
    vpcSecurityGroupIds: [db_secgrp.id],
});

export const rdsEndpoint = postgresql.endpoint;
export const rdsArn = postgresql.arn;
export const rdsConnectionUrl = pulumi.interpolate`psql://${dbUsername}:${dbPassword}@${rdsEndpoint}/${dbName}`
export const rdsId = postgresql.id

//////////////////////////////////////////////////////////////
// Set up Redis
//////////////////////////////////////////////////////////////

const redisSubnetGroup = new aws.elasticache.SubnetGroup("gitcoin-cache-subnet-group", {
    subnetIds: vpcPrivateSubnetIds
});

const secgrp_redis = new aws.ec2.SecurityGroup("secgrp_redis", {
    description: "gitcoin",
    vpcId: vpc.id,
    ingress: [
        { protocol: "tcp", fromPort: 6379, toPort: 6379, cidrBlocks: ["0.0.0.0/0"] },
    ],
    egress: [{
        protocol: "-1",
        fromPort: 0,
        toPort: 0,
        cidrBlocks: ["0.0.0.0/0"],
    }],
});

const redis = new aws.elasticache.Cluster("gitcoin-cache", {
    engine: "redis",
    engineVersion: "4.0.10",
    nodeType: "cache.t2.micro",
    numCacheNodes: 1,
    port: 6379,
    subnetGroupName: redisSubnetGroup.name,
    securityGroupIds: [secgrp_redis.id]
});


export const redisPrimaryNode = redis.cacheNodes[0];
export const redisConnectionUrl = pulumi.interpolate`rediscache://${redisPrimaryNode.address}:${redisPrimaryNode.port}/0?client_class=django_redis.client.DefaultClient`
export const redisCacheOpsConnectionUrl = pulumi.interpolate`redis://${redisPrimaryNode.address}:${redisPrimaryNode.port}/0`

//////////////////////////////////////////////////////////////
// Set up ALB and ECS cluster
//////////////////////////////////////////////////////////////

const cluster = new awsx.ecs.Cluster("gitcoin", { vpc });
// export const clusterInstance = cluster;
export const clusterId = cluster.id;
const listener = new awsx.lb.ApplicationListener("app", { port: 80, vpc: cluster.vpc });


let environment = [
    {
        name: "ENV",
        value: "test"
    },
    // read me to understand this file:
    // https://github.com/gitcoinco/web/blob/master/docs/ENVIRONMENT_VARIABLES.md

    ///////////////////////////////////////////////////////////////////////////////
    // BASIC PARAMS
    ///////////////////////////////////////////////////////////////////////////////
    {
        name: "CACHE_URL",
        value: "dbcache://my_cache_table"
    },
    {
        name: "REDIS_URL",
        value: redisConnectionUrl
    },
    {
        name: "CACHEOPS_REDIS",
        value: redisCacheOpsConnectionUrl
    },
    {   // TODO: drop this
        name: "COLLECTFAST_CACHE_URL",
        value: "dbcache://collectfast"
    },
    {
        name: "DATABASE_URL",
        value: rdsConnectionUrl
    },
    // {
    //     name: "READ_REPLICA_1_DATABASE_URL",
    //     value: rdsConnectionUrl
    // },
    // {
    //     name: "READ_REPLICA_2_DATABASE_URL",
    //     value: rdsConnectionUrl
    // },
    // {
    //     name: "READ_REPLICA_3_DATABASE_URL",
    //     value: rdsConnectionUrl
    // },
    // {
    //     name: "READ_REPLICA_4_DATABASE_URL",
    //     value: rdsConnectionUrl
    // },
    {
        name: "DEBUG",
        value: "on"
    },
    {
        name: "BASE_URL",
        value: "http://127.0.0.1:8000/"
    },

    ///////////////////////////////////////////////////////////////////////////////
    // DOCKER PROVISIONING PARAMS
    ///////////////////////////////////////////////////////////////////////////////
    // {
    // name: "FORCE_PROVISION",
    // value: "on"
    // },
    {
        name: "DISABLE_PROVISION",
        value: "on"
    },
    {
        name: "DISABLE_INITIAL_CACHETABLE",
        value: "on"
    },
    {
        name: "DISABLE_INITIAL_COLLECTSTATIC",
        value: "on"
    },
    {
        name: "DISABLE_INITIAL_LOADDATA",
        value: "off"
    },
    {
        name: "DISABLE_INITIAL_MIGRATE",
        value: "off"
    },

    ///////////////////////////////////////////////////////////////////////////////
    // ADVANCED NOTIFICATION PARAMS
    ///////////////////////////////////////////////////////////////////////////////
    // Be VERY CAREFUL when changing this setting.  You don't want to accidentally
    // spam a bunch of github notifications :)
    {
        name: "ENABLE_NOTIFICATIONS_ON_NETWORK",
        value: "rinkeby"
    },

    // Please checkout [Integration Docs](https://github.com/gitcoinco/web/blob/master/docs/THIRD_PARTY_SETUP.md)
    {
        name: "GITHUB_API_USER",
        value: githubApiUser
    },
    {
        name: "GITHUB_API_TOKEN",
        value: githubApiToken
    },

    // For Login integration with Github (login button in top right)
    {
        name: "GITHUB_CLIENT_ID",
        value: githubClientId
    },
    {
        name: "GITHUB_CLIENT_SECRET",
        value: githubClientSecret
    },
    {
        name: "GITHUB_APP_NAME",
        value: githubAppName
    },
    {
        name: "CHAT_SERVER_URL",
        value: "chat"
    },
    {
        name: "CHAT_URL",
        value: "localhost"
    },

    // To enable Google verification(in profile's trust tab)
    {
        name: "GOOGLE_CLIENT_ID",
        value: ""
    },
    {
        name: "GOOGLE_CLIENT_SECRET",
        value: ""
    },

    // For Facebook integration (in profile's trust tab)
    {
        name: "FACEBOOK_CLIENT_ID",
        value: ""
    },
    {
        name: "FACEBOOK_CLIENT_SECRET",
        value: ""
    },

    // For notion integration (on grant creation)
    {
        name: "NOTION_API_KEY",
        value: ""
    },
    {
        name: "NOTION_SYBIL_DB",
        value: ""
    },

    {
        name: "INFURA_USE_V3",
        value: "True"
    },

    {
        name: "SUPRESS_DEBUG_TOOLBAR",
        value: "1"
    },

    {
        name: "SENDGRID_API_KEY",
        value: ""
    },
    {
        name: "CONTACT_EMAIL",
        value: ""
    },

    {
        name: "FEE_ADDRESS",
        value: ""
    },
    {
        name: "FEE_ADDRESS_PRIVATE_KEY",
        value: ""
    },
    {
        name: "GIPHY_KEY",
        value: ""
    },
    {
        name: "YOUTUBE_API_KEY",
        value: ""
    },
    {
        name: "VIEW_BLOCK_API_KEY",
        value: ""
    },
    {
        name: "ETHERSCAN_API_KEY",
        value: ""
    },
    {
        name: "POLYGONSCAN_API_KEY",
        value: "K2FQK241WVVIQ66YJRK3NIMYPR8ZX3GM6D"
    },
    {
        name: "FORTMATIC_LIVE_KEY",
        value: ""
    },
    {
        name: "FORTMATIC_TEST_KEY",
        value: ""
    },
    {
        name: "XINFIN_API_KEY",
        value: ""
    },
    {
        name: "ALGORAND_API_KEY",
        value: ""
    },

    {
        name: "PYPL_CLIENT_ID",
        value: ""
    },

    {
        name: "BRIGHTID_PRIVATE_KEY",
        value: ""
    },

    {
        name: "PREMAILER_CACHE",
        value: "LRU"
    },
    {
        name: "PREMAILER_CACHE_MAXSIZE",
        value: "4096"
    },

    {
        name: "GTC_DIST_API_URL",
        value: ""
    },
    {
        name: "GTC_DIST_KEY",
        value: ""
    },

    // CYPRESS METAMASK VARIABLES
    {
        name: "NETWORK_NAME",
        value: "localhost"
    },
    {
        name: "SECRET_WORDS",
        value: ""
    },
    {
        name: "PASSWORD",
        value: ""
    },
    {
        name: "CYPRESS_REMOTE_DEBUGGING_PORT",
        value: "9222"
    },

    {
        name: "TEST_MNEMONIC",
        value: "chief loud snack trend chief net field husband vote message decide replace"
    },

    ///////////////////////////////////////////////////////////////////////////////
    // Specific for review env test
    ///////////////////////////////////////////////////////////////////////////////
    {
        name: "AWS_ACCESS_KEY_ID",
        value: usrLoggerKey
    },
    {
        name: "AWS_SECRET_ACCESS_KEY",
        value: usrLoggerSecret
    },
    {
        name: "AWS_DEFAULT_REGION",
        value: "us-west-2"          // TODO: configure this
    },

    {
        name: "AWS_STORAGE_BUCKET_NAME",
        value: bucketWebURL
    },
    {
        name: "STATIC_HOST",
        value: bucketWebURL
    },
    {
        name: "STATIC_URL",
        value: "static/"
    },
    // This is used for prod: STATICFILES_STORAGE = env('STATICFILES_STORAGE', default='app.static_storage.SilentFileStorage')
    // STATICFILES_STORAGE = env('STATICFILES_STORAGE', default='django.contrib.staticfiles.storage.StaticFilesStorage')
    // Going with this for the time being:  django.contrib.staticfiles.storage.StaticFilesStorage 
    {
        name: "STATICFILES_STORAGE",
        value: "django.contrib.staticfiles.storage.StaticFilesStorage"
    },
    {
        name: "BUNDLE_USE_CHECKSUM",
        value: "false",
    }

];

const task = new awsx.ecs.FargateTaskDefinition("task", {
    containers: {
        web: {
            image: dockerGtcWebImage,
            command: ["/bin/review-env-initial-data.bash"],
            memory: 4096,
            cpu: 2000,
            portMappings: [],
            environment: environment,
            dependsOn: [],
            links: []
        },
    },
});


export const taskDefinition = task.taskDefinition.id;

const service = new awsx.ecs.FargateService("app", {
    cluster,
    desiredCount: 1,
    assignPublicIp: false,
    taskDefinitionArgs: {
        containers: {
            web: {
                image: dockerGtcWebImage,
                memory: 512,
                portMappings: [listener],
                environment: environment,
                links: []
            },
        },
    },
});

// Export the URL so we can easily access it.
export const frontendURL = pulumi.interpolate`http://${listener.endpoint.hostname}/`;
export const frontend = listener.endpoint


//////////////////////////////////////////////////////////////
// Set up EC2 instance 
//      - it is intended to be used for troubleshooting
//////////////////////////////////////////////////////////////

// Create a new security group that permits SSH and web access.
const secgrp = new aws.ec2.SecurityGroup("secgrp", {
    description: "gitcoin",
    vpcId: vpc.id,
    ingress: [
        { protocol: "tcp", fromPort: 22, toPort: 22, cidrBlocks: ["0.0.0.0/0"] },
        { protocol: "tcp", fromPort: 80, toPort: 80, cidrBlocks: ["0.0.0.0/0"] },
    ],
    egress: [{
        protocol: "-1",
        fromPort: 0,
        toPort: 0,
        cidrBlocks: ["0.0.0.0/0"],
    }],
});

export const securityGroupsForEc2 = secgrp.id;

const ubuntu = aws.ec2.getAmi({
    mostRecent: true,
    filters: [
        {
            name: "name",
            values: ["ubuntu/images/hvm-ssd/ubuntu-focal-20.04-amd64-server-*"],
        },
        {
            name: "virtualization-type",
            values: ["hvm"],
        },
    ],
    owners: ["099720109477"],
});

// Script to install docker in ec2 instance
const ec2InitScript = `#!/bin/bash

# Installing docker in ubuntu
# Instructions taken from here: https://docs.docker.com/engine/install/ubuntu/

mkdir /var/log/gitcoin
echo $(date) "Starting installation of docker" >> /var/log/gitcoin/init.log
apt-get remove docker docker-engine docker.io containerd runc

apt-get update

apt-get install -y \
    ca-certificates \
    curl \
    gnupg \
    lsb-release
    
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg

echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/ubuntu \
  $(lsb_release -cs) stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null
  
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io
mkdir /var/log/gitcoin
echo $(date) "Finished installation of docker" >> /var/log/gitcoin/init.log

`

const web = new aws.ec2.Instance("Web", {
    ami: ubuntu.then(ubuntu => ubuntu.id),
    associatePublicIpAddress: true,
    instanceType: "t3.micro",
    subnetId: vpcPublicSubnet1.then(),

    vpcSecurityGroupIds: [secgrp.id],
    rootBlockDevice: {
        volumeSize: 50
    },
    tags: {
        Name: "Troubleshooting instance",
    },
    userData: ec2InitScript,
});

export const ec2PublicIp = web.publicIp;

