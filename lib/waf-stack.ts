import * as cdk from 'aws-cdk-lib';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';

import { Construct } from 'constructs';

interface WafStackProps extends cdk.StackProps {
  stage: 'dev' | 'staging' | 'prod';
}

export class WafStack extends cdk.Stack {

  public readonly webAclArn: string;
  public readonly certificateArn: string;

  constructor(scope: Construct, id: string, props?: WafStackProps) {
    super(scope, id, props);
    const stage = props?.stage || 'dev';
    const is_prod = stage == 'prod';
    const webAcl = new wafv2.CfnWebACL(this, `NexusWebACL${stage}`, {
      defaultAction: { allow: {} },
      scope: 'CLOUDFRONT',
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: 'webACL',
        sampledRequestsEnabled: true,
      },
      rules: [
        {
          name: 'AWS-AWSManagedRulesCommonRuleSet',
          priority: 1,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesCommonRuleSet',
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'AWS-AWSManagedRulesCommonRuleSet',
            sampledRequestsEnabled: true,
          },
        },
      ],
    });

    const domain_name = is_prod ? `projectglint.com` : `${stage}.projectglint.com`;

    const certificate = new acm.Certificate(this, `NexusCertificate${stage}`, {
      domainName: domain_name,
      validation: acm.CertificateValidation.fromDns()
    });
    this.certificateArn = certificate.certificateArn;
    this.webAclArn = webAcl.attrArn;
  }
}