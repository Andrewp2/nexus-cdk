import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as cf_origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as apigateway from 'aws-cdk-lib/aws-apigatewayv2';
import { Construct } from 'constructs';

export class CdkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Things needed -

    // S3 Bucket
    // Cloudformation distribution
    // API Gateway
    // AWS Lambda
    const bucket = new s3.Bucket(this, 'MyBucket', {
      bucketName: 'my-new-static-asset-bucket',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const cf_distribution = new cloudfront.Distribution(this, 'MyDistribution', {
      defaultBehavior: {
        origin: new cf_origins.S3Origin(bucket)
      }
    });

    const fat_lambda = new lambda.Function(this, 'MyFunction', {
      runtime: lambda.Runtime.PROVIDED_AL2,
      handler: 'index.main',
      code: lambda.Code.fromAsset("../nexus/target/lambda/nexus/bootstrap.zip"),
      architecture: lambda.Architecture.ARM_64,
      memorySize: 128,
    });

    const gateway = new apigateway.CfnApi(this, 'MyHttpApi', {
      name: 'MyHttpApi',
      protocolType: 'HTTP',
    });

    const integration = new apigateway.CfnIntegration(this, 'MyLambdaIntegration', {
      apiId: gateway.ref,
      integrationType: 'AWS_PROXY',
      integrationUri: fat_lambda.functionArn,
      payloadFormatVersion: '2.0',
    });

    const route = new apigateway.CfnRoute(this, 'MyRoute', {
      apiId: gateway.ref,
      routeKey: '$default',
      target: 'integrations/' + integration.ref
    });
  }
}
