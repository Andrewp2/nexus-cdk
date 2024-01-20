import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as cf_origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as apigateway from 'aws-cdk-lib/aws-apigatewayv2';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

interface MyStackProps extends cdk.StackProps {
  stage: 'dev' | 'staging' | 'prod';
}

export class CdkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: MyStackProps) {
    super(scope, id, props);

    // Things needed -

    // S3 Bucket
    // Cloudformation distribution
    // API Gateway
    // AWS Lambda
    // DynamoDB
    // const bucket = new s3.Bucket(this, 'MyBucket', {
    //   bucketName: 'my-new-static-asset-bucket',
    //   removalPolicy: cdk.RemovalPolicy.DESTROY,
    // });

    // const cf_distribution = new cloudfront.Distribution(this, 'MyDistribution', {
    //   defaultBehavior: {
    //     origin: new cf_origins.S3Origin(bucket)
    //   }
    // });

    const envConfig = this.loadConfig(props?.stage || 'unknown');

    const fat_lambda = new lambda.Function(this, `NexusSSRFunction${envConfig.suffix}`, {
      runtime: lambda.Runtime.PROVIDED_AL2,
      handler: 'index.main',
      code: lambda.Code.fromAsset("../nexus/target/lambda/nexus/bootstrap.zip"),
      architecture: lambda.Architecture.ARM_64,
      memorySize: 128,
    });

    const gateway = new apigateway.CfnApi(this, `NexusHTTPApi${envConfig.suffix}`, {
      name: 'MyHttpApi',
      protocolType: 'HTTP',
    });

    const integration = new apigateway.CfnIntegration(this, `NexusAPILambdaIntegration${envConfig.suffix}`, {
      apiId: gateway.ref,
      integrationType: 'AWS_PROXY',
      integrationUri: fat_lambda.functionArn,
      payloadFormatVersion: '2.0',
    });

    const route = new apigateway.CfnRoute(this, `NexusRoute${envConfig.suffix}`, {
      apiId: gateway.ref,
      routeKey: '$default',
      target: 'integrations/' + integration.ref
    });

    const table = new dynamodb.Table(this, `NexusDynamoTable${envConfig.suffix}`, {
      tableName: `Users${envConfig.suffix}`,
      partitionKey: { name: 'email', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    });

    table.addGlobalSecondaryIndex({
      indexName: 'user_uuid-index',
      partitionKey: {
        name: 'user_uuid',
        type: dynamodb.AttributeType.STRING,
      }
    });

    table.addGlobalSecondaryIndex({
      indexName: 'session_id-index',
      partitionKey: {
        name: 'session_id',
        type: dynamodb.AttributeType.STRING,
      }
    });

    table.addGlobalSecondaryIndex({
      indexName: 'email_verification_uuid-index',
      partitionKey: {
        name: 'email_verification_uuid',
        type: dynamodb.AttributeType.STRING,
      }
    });
  }

  private loadConfig(stage: string): NexusConfig {
    // Load configuration based on the environment
    // This could be from a file, process.env, or any other source
    switch (stage) {
      case 'dev':
        return {
          suffix: '-dev'
        }
      case 'staging':
        return { suffix: '-staging' };
      case 'prod':
        return { suffix: '' };
      default:
        throw new Error(`Unknown environment: ${stage}`);
    }
  }
}

interface NexusConfig {
  suffix: string;
}
