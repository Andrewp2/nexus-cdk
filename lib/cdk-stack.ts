import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as cf_origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as apigateway from 'aws-cdk-lib/aws-apigatewayv2';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as aws_logs from 'aws-cdk-lib/aws-logs';
import * as ses from 'aws-cdk-lib/aws-ses';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sns_subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as cloudwatch_actions from 'aws-cdk-lib/aws-cloudwatch-actions';

import { Construct } from 'constructs';

interface MyStackProps extends cdk.StackProps {
  stage: 'dev' | 'staging' | 'prod';
  webAclArn: string
}

export class CdkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: MyStackProps) {
    super(scope, id, props);
    const stage = props?.stage || 'dev';
    const is_prod = stage == 'prod';
    const bucket = new s3.Bucket(this, `NexusBucket${stage}`, {
      bucketName: `nexus-static-asset-bucket-${stage}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    let stripe_secret_key = process.env.STRIPE_SECRET_KEY!;
    const fat_lambda = new lambda.Function(this, `NexusSSRFunction${stage}`, {
      runtime: lambda.Runtime.PROVIDED_AL2023,
      handler: 'index.main',
      code: lambda.Code.fromAsset("../nexus/target/lambda/server/bootstrap.zip"),
      architecture: lambda.Architecture.ARM_64,
      memorySize: 128,
      environment: {
        "STRIPE_SECRET_KEY": stripe_secret_key
      },
      timeout: cdk.Duration.millis(3000),
      logGroup: new aws_logs.LogGroup(this, `NexusLambdaLogGroup${stage}`, {
        retention: aws_logs.RetentionDays.FIVE_DAYS,
      })
    });
    // TODO: Add SecretsManager permission to lambda
    const lambda_integration = new integrations.HttpLambdaIntegration(`LambdaIntegration${stage}`, fat_lambda);
    const http_api = new apigateway.HttpApi(this, `HttpApi${stage}`, {
      defaultIntegration: lambda_integration,
    });
    http_api.addRoutes({
      path: '/',
      methods: [apigateway.HttpMethod.GET],
      integration: lambda_integration
    });
    const cf_distribution = new cloudfront.Distribution(this, `NexusDistribution${stage}`, {
      defaultBehavior: {
        origin: new cf_origins.HttpOrigin(`${http_api.httpApiId}.execute-api.${this.region}.amazonaws.com`),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      },
      additionalBehaviors: {
        '/pkg/*': {
          origin: new cf_origins.S3Origin(bucket),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
        }
      },
      priceClass: cloudfront.PriceClass.PRICE_CLASS_ALL,
      comment: `${stage}`,
      webAclId: props?.webAclArn
    });

    const table_suffix = is_prod ? '' : `${stage}`;
    const table = new dynamodb.TableV2(this, `NexusDynamoTable${stage}`, {
      tableName: `Users-${table_suffix}`,
      partitionKey: { name: 'email', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand()
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
      },
    });
    const configuration_set = new ses.ConfigurationSet(this, `NexusSESConfigurationSet${stage}`, {
      reputationMetrics: true,
      tlsPolicy: ses.ConfigurationSetTlsPolicy.REQUIRE,
      configurationSetName: `NexusTransactionalEmailConfigurationSet${stage}`,
    });
    const email = 'andrew' + (is_prod ? `` : `+${stage}`) + '@projectGlint.com'
    const email_identity = new ses.EmailIdentity(this, `VerifiedEmailIdentity${stage}`, {
      identity: { value: email },
      configurationSet: configuration_set
    });
    const ses_policy = new iam.Policy(this, `SesSendEmailPolicy${stage}`, {
      statements: [
        new iam.PolicyStatement({
          actions: ['ses:SendEmail', 'ses:SendRawEmail'],
          resources: [fat_lambda.functionArn]
        })
      ]
    });
    const sns_topic = new sns.Topic(this, `NexusSESNotificationTopic${stage}`, {
      displayName: `SES Notifications ${stage}`
    });
    const ses_tracking_options = new ses.ConfigurationSetEventDestination(this, `NexusSESTrackingOptions${stage}`, {
      configurationSet: configuration_set,
      configurationSetEventDestinationName: `NexusConfigurationSet${stage}`,
      destination: {
        topic: sns_topic
      },
      events: [
        ses.EmailSendingEvent.BOUNCE,
        ses.EmailSendingEvent.COMPLAINT,
        ses.EmailSendingEvent.REJECT,
        ses.EmailSendingEvent.RENDERING_FAILURE,
      ]
    });
    sns_topic.addSubscription(
      new sns_subscriptions.EmailSubscription(`andrew@projectGlint.com`)
    );
    const sns_action = new cloudwatch_actions.SnsAction(sns_topic);
    // TODO: Add SNS and lambda to shut off cloudfront distribution if budget exceeds maximum
    const budget = new budgets.CfnBudget(this, `NexusBudget${stage}`, {
      budget: {
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: {
          amount: 100,
          unit: 'USD',
        },
      },
      notificationsWithSubscribers: [
        {
          notification: {
            notificationType: 'FORECASTED',
            comparisonOperator: 'GREATER_THAN',
            threshold: 100,
            thresholdType: 'PERCENTAGE',
          },
          subscribers: [
            {
              subscriptionType: 'EMAIL',
              address: 'andrew@ProjectGlint.com',
            },
            {
              subscriptionType: 'EMAIL',
              address: 'apeterson2775@gmail.com'
            }
          ],
        },
      ],
    });
    // we'll just have api gateway alarms for now
    const cloudfront_alarms: cloudwatch.Alarm[] = [
    ];
    // 4XX errors, 5XX errors, Latency Alarm
    const api_gateway_alarms = [
      new cloudwatch.Alarm(this, `APIGateway4XXErrorAlarm${stage}`, {
        metric: http_api.metricClientError({
          period: cdk.Duration.seconds(60),
          statistic: 'Average',
        }),
        threshold: 0.05,
        evaluationPeriods: 5,
        datapointsToAlarm: 5,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: 'Alarm when API Gateway has >5% of client errors',
      }),
      new cloudwatch.Alarm(this, `APIGateway5XXErrorAlarm${stage}`, {
        metric: http_api.metricServerError({
          period: cdk.Duration.seconds(60),
          statistic: 'Average',
        }),
        threshold: 0.05,
        evaluationPeriods: 3,
        datapointsToAlarm: 3,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: 'Alarm when API Gateway has >5% of server errors',
      }),
      new cloudwatch.Alarm(this, `APIGatewayLatencyAlarm${stage}`, {
        metric: http_api.metricLatency({
          period: cdk.Duration.seconds(60),
          statistic: 'p90',
        }),
        threshold: 2000.00,
        evaluationPeriods: 5,
        datapointsToAlarm: 5,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: 'Alarm when API Gateway has increased latency'
      }),
    ];
    // SuccessfulRequestLatency, SystemErrors, TableReadThrottles PUT, TableWriteThrottles,
    const dynamo_alarms = [
      new cloudwatch.Alarm(this, `DynamoDBSuccessfulRequestLatencyPutItem${stage}`, {
        metric: table.metricSuccessfulRequestLatency({
          statistic: 'Average',
          period: cdk.Duration.seconds(60),
          dimensionsMap: {
            Operation: dynamodb.Operation.PUT_ITEM
          }
        }),
        threshold: 20,
        evaluationPeriods: 10,
        datapointsToAlarm: 10,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: `DynamoDB Latency Too High`
      }),
      new cloudwatch.Alarm(this, `DynamoDBSuccessfulRequestLatencyGetItem${stage}`, {
        metric: table.metricSuccessfulRequestLatency({
          statistic: 'Average',
          period: cdk.Duration.seconds(60),
          dimensionsMap: {
            Operation: dynamodb.Operation.GET_ITEM
          }
        }),
        threshold: 20,
        evaluationPeriods: 10,
        datapointsToAlarm: 10,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: `DynamoDB Latency Too High`
      }),
      new cloudwatch.Alarm(this, `DynamoDBSystemErrors${stage}`, {
        metric: table.metricSystemErrorsForOperations({
          statistic: 'Sum',
          period: cdk.Duration.seconds(60),
          operations: [dynamodb.Operation.GET_ITEM, dynamodb.Operation.PUT_ITEM]
        }),
        threshold: 20,
        evaluationPeriods: 5,
        datapointsToAlarm: 5,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: `DynamoDB System Errors`
      }),
      new cloudwatch.Alarm(this, `DynamoDBTableReadThrottles${stage}`, {
        metric: table.metricThrottledRequestsForOperation(dynamodb.Operation.GET_ITEM, {
          statistic: 'Sum',
          period: cdk.Duration.seconds(60),
        }),
        threshold: 50,
        evaluationPeriods: 5,
        datapointsToAlarm: 5,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: `DynamoDB Read Throttles (GET_ITEM)`
      }),
      new cloudwatch.Alarm(this, `DynamoDBTableWriteThrottles${stage}`, {
        metric: table.metricThrottledRequestsForOperation(dynamodb.Operation.PUT_ITEM, {
          statistic: 'Sum',
          period: cdk.Duration.seconds(60),
        }),
        threshold: 50,
        evaluationPeriods: 5,
        datapointsToAlarm: 5,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: `DynamoDB Write Throttles (PUT_ITEM)`
      }),
    ];
    const accountConcurrencyMetric = new cloudwatch.Metric({
      namespace: 'AWS/Lambda',
      metricName: 'ConcurrentExecutions',
      statistic: 'Maximum',
      period: cdk.Duration.seconds(60),
    });
    // account concurrency, errors, throttles, latency/duration
    const lambda_alarms: cloudwatch.Alarm[] = [
      new cloudwatch.Alarm(this, `LambdaConcurrentExecutionsOverAccountMaximum${stage}`, {
        metric: accountConcurrencyMetric,
        threshold: 500,
        evaluationPeriods: 10,
        datapointsToAlarm: 10,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        alarmDescription: 'This alarm monitors if the concurrency of your Lambda functions is approaching the Region-level concurrency limit of your account.',
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
      new cloudwatch.Alarm(this, `FatLambdaErrors${stage}`, {
        metric: fat_lambda.metricErrors({
          period: cdk.Duration.seconds(60),
          statistic: 'Sum'
        }),
        threshold: 5,
        evaluationPeriods: 3,
        datapointsToAlarm: 3,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: 'Errors when errors of AWS Lambda are too high'
      }),
      new cloudwatch.Alarm(this, `FatLambdaThrottles${stage}`, {
        metric: fat_lambda.metricThrottles({
          period: cdk.Duration.seconds(60),
          statistic: 'Sum'
        }),
        threshold: 5,
        evaluationPeriods: 5,
        datapointsToAlarm: 5,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: 'Errors when throttles of AWS Lambda are too high'
      })
      ,
      new cloudwatch.Alarm(this, `FatLambdaDuration${stage}`, {
        metric: fat_lambda.metricDuration({
          period: cdk.Duration.seconds(60),
          statistic: 'p90'
        }),
        threshold: 2000.0,
        evaluationPeriods: 15,
        datapointsToAlarm: 15,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: 'Errors when throttles of AWS Lambda are too high'
      })
    ];
    const ses_alarms: cloudwatch.Alarm[] = [
      new cloudwatch.Alarm(this, `SESBounce${stage}`, {
        metric: new cloudwatch.Metric({
          namespace: 'AWS/SES',
          metricName: 'BounceRate',
          dimensionsMap: {
            "Identity": email
          },
          statistic: 'Average',
          period: cdk.Duration.hours(3),
        }),
        threshold: 0.05,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: `Alarm when SES Bounce Rate exceeds threshold`,
        actionsEnabled: true,
      }),
      new cloudwatch.Alarm(this, `SESComplaint${stage}`, {
        metric: new cloudwatch.Metric({
          namespace: 'AWS/SES',
          metricName: 'ComplaintRate',
          dimensionsMap: {
            "Identity": email
          },
          statistic: 'Average',
          period: cdk.Duration.hours(3),
        }),
        threshold: 0.01,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: `Alarm when SES Complaint Rate exceeds threshold`,
        actionsEnabled: true,
      })
    ];
    ses_alarms.forEach((sns_alarm) => {
      sns_alarm.addAlarmAction(sns_action);
    });
    const alarms = [
      ...ses_alarms,
      ...cloudfront_alarms,
      ...api_gateway_alarms,
      ...dynamo_alarms,
      ...lambda_alarms
    ];
    const dashboard_period = cdk.Duration.hours(3);
    const dashboard = new cloudwatch.Dashboard(this, `NexusDashboard${stage}`, {
      dashboardName: `NexusDashboard${stage}`,
      widgets: [
        [
          new cloudwatch.TextWidget({
            markdown: `# Nexus Dashboard ${stage}`,
            width: 24,
            height: 1,
          })
        ],
        [
          new cloudwatch.GraphWidget({
            title: `API Gateway Latency`,
            left: [http_api.metricLatency()],
            width: 8,
            period: dashboard_period,
          }),
          new cloudwatch.GraphWidget({
            title: `Lambda Invocations`,
            left: [fat_lambda.metricInvocations()],
            width: 8,
            period: dashboard_period,
          }),
          new cloudwatch.GraphWidget({
            title: `Lambda Errors`,
            left: [fat_lambda.metricErrors()],
            width: 8,
            period: dashboard_period,
          })
        ],
        [
          new cloudwatch.GraphWidget({
            title: 'DynamoDB Read Capacity',
            left: [table.metricConsumedReadCapacityUnits()],
            width: 12,
            period: dashboard_period,
          }), new cloudwatch.GraphWidget({
            title: 'DynamoDB Write Capacity',
            left: [table.metricConsumedWriteCapacityUnits()],
            width: 12,
            period: dashboard_period,
          })
        ],
        [
          new cloudwatch.GraphWidget({
            title: 'CloudFront Requests',
            left: [cf_distribution.metricRequests()],
            width: 12,
            period: dashboard_period,
          }), new cloudwatch.GraphWidget({
            title: 'Static Asset S3 Bucket Size',
            left: [new cloudwatch.Metric({
              namespace: `AWS/S3`,
              metricName: `BucketSizeBytes`,
              statistic: 'Average',
              period: dashboard_period
            })],
            width: 12
          })
        ],
        [
          new cloudwatch.AlarmStatusWidget({ alarms: alarms, width: 24, title: `Alarms` })
        ]
      ]
    });
  }
}