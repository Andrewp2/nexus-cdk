#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { CdkStack } from '../lib/cdk-stack';
import { WafStack } from '../lib/waf-stack';

const app = new cdk.App();
const stage = process.env.STAGE || 'dev';
if (stage != 'dev' && stage != 'prod' && stage != 'staging') {
  throw new Error("stage incorrect")
}
let waf_stack = new WafStack(app, `WafCdkStack-${stage}`, {
  stage: stage,
  description: `Stack created by CDK code for WebACL (Rust Leptos Project) ${stage}`,
  env: {
    region: 'us-east-1'
  }
});
new CdkStack(app, `NexusCdkStack-${stage}`, {
  stage: stage,
  description: `Stack created by CDK code (Rust Leptos Project) ${stage}`,
  webAclArn: waf_stack.webAclArn
});