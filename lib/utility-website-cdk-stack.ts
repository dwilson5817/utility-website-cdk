import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as s3 from 'aws-cdk-lib/aws-s3';

export class UtilityWebsiteCdkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const hostedZone = new route53.HostedZone(this, 'HostedZone', {
      zoneName: 'tools.dylanw.dev',
    });

    new route53.CaaRecord(this, 'AcmCaaRecord', {
      zone: hostedZone,
      values: [
        { flag: 0, tag: route53.CaaTag.ISSUE, value: 'amazon.com' },
        { flag: 0, tag: route53.CaaTag.ISSUE, value: 'amazontrust.com' },
        { flag: 0, tag: route53.CaaTag.ISSUE, value: 'awstrust.com' },
        { flag: 0, tag: route53.CaaTag.ISSUE, value: 'amazonaws.com' },
        { flag: 0, tag: route53.CaaTag.ISSUE, value: 'letsencrypt.org' },
      ],
    });

    new cdk.CfnOutput(this, 'HostedZoneNameServers', {
      description: 'NS records to add to dylanw.net to delegate dmarc.dylanw.net to Route 53',
      value: cdk.Fn.join(', ', hostedZone.hostedZoneNameServers!),
    });

    const artifactsBucket = new s3.Bucket(this, 'ArtifactsBucket', {
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [{
        noncurrentVersionExpiration: cdk.Duration.days(1),
        noncurrentVersionsToRetain: 5,
      }],
    });

    new cdk.CfnOutput(this, 'ArtifactsBucketName', {
      value: artifactsBucket.bucketName,
    });
  }
}
