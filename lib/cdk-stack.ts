import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as cf_origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as apigateway from 'aws-cdk-lib/aws-apigatewayv2';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';

import { Construct } from 'constructs';

interface MyStackProps extends cdk.StackProps {
  stage: 'dev' | 'staging' | 'prod';
}

export class CdkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: MyStackProps) {
    super(scope, id, props);

    const envConfig = this.loadConfig(props?.stage || 'unknown');

    const bucket = new s3.Bucket(this, `NexusBucket${envConfig.suffix}`, {
      bucketName: `nexus-static-asset-bucket${envConfig.suffix}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const fat_lambda = new lambda.Function(this, `NexusSSRFunction${envConfig.suffix}`, {
      runtime: lambda.Runtime.PROVIDED_AL2,
      handler: 'index.main',
      code: lambda.Code.fromAsset("../nexus/target/lambda/nexus/bootstrap.zip"),
      architecture: lambda.Architecture.X86_64,
      memorySize: 128,
    });

    const lambda_integration = new integrations.HttpLambdaIntegration(`LambdaIntegration${envConfig.suffix}`, fat_lambda);

    const httpApi = new apigateway.HttpApi(this, 'HttpApi', {
      defaultIntegration: lambda_integration,
    });
    httpApi.addRoutes({
      path: '/',
      methods: [apigateway.HttpMethod.GET],
      integration: lambda_integration
    });

    const cf_distribution = new cloudfront.Distribution(this, `NexusDistribution${envConfig.suffix}`, {
      defaultBehavior: {
        origin: new cf_origins.HttpOrigin(`${httpApi.httpApiId}.execute-api.${this.region}.amazonaws.com`),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      additionalBehaviors: {
        '/pkg/*': {
          origin: new cf_origins.S3Origin(bucket),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        }
      },
      comment: `${envConfig.suffix}`,
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
