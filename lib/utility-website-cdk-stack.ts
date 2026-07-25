import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigwv2Integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';

const BASE_DOMAIN = 'tools.dylanw.dev';

const API_SUBDOMAIN = 'api';
const API_DOMAIN_NAME = `${API_SUBDOMAIN}.${BASE_DOMAIN}`;

// Origins allowed to call the API: the deployed frontend, plus the Vite dev
// server so a local frontend can be pointed at the deployed API.
const ALLOWED_ORIGINS = [`https://${BASE_DOMAIN}`, 'http://localhost:5173'];

export class UtilityWebsiteCdkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const hostedZone = new route53.HostedZone(this, 'HostedZone', {
      zoneName: BASE_DOMAIN,
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

    const artifactsBucket = new s3.Bucket(this, 'ArtifactsBucket', {
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [{
        noncurrentVersionExpiration: cdk.Duration.days(1),
        noncurrentVersionsToRetain: 5,
      }],
    });

    // The build pipeline uploads function.zip to the artifacts bucket and writes
    // the resulting S3 object version to SSM, so a deploy picks up the code that
    // the parameter points at rather than whatever is current.
    const interrailVersion = ssm.StringParameter.valueForStringParameter(
      this,
      '/utility-website/artifacts/api/interrail_handler/version',
    );

    const interrailFunction = new lambda.Function(this, 'InterrailFunction', {
      runtime: lambda.Runtime.PYTHON_3_13,
      // FastAPI app wrapped by Mangum in main.py at the root of the zip.
      handler: 'main.handler',
      code: lambda.Code.fromBucketV2(
        artifactsBucket,
        'utility-website-api/interrail_handler/function.zip',
        { objectVersion: interrailVersion },
      ),
      memorySize: 512,
      timeout: cdk.Duration.seconds(30),
      logGroup: new logs.LogGroup(this, 'InterrailFunctionLogGroup', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });

    // Regional endpoint, so the certificate lives in this stack's region rather
    // than us-east-1. Validation records are written to the hosted zone above.
    const apiCertificate = new acm.Certificate(this, 'ApiCertificate', {
      domainName: API_DOMAIN_NAME,
      validation: acm.CertificateValidation.fromDns(hostedZone),
    });

    const apiDomainName = new apigwv2.DomainName(this, 'ApiDomainName', {
      domainName: API_DOMAIN_NAME,
      certificate: apiCertificate,
    });

    new route53.ARecord(this, 'ApiARecord', {
      zone: hostedZone,
      recordName: API_SUBDOMAIN,
      target: route53.RecordTarget.fromAlias(
        new route53Targets.ApiGatewayv2DomainProperties(
          apiDomainName.regionalDomainName,
          apiDomainName.regionalHostedZoneId,
        ),
      ),
    });

    // CORS is handled by the API rather than the FastAPI app: when an HTTP API
    // defines CORS, API Gateway answers preflights itself and drops any CORS
    // headers the integration returns.
    const api = new apigwv2.HttpApi(this, 'Api', {
      // Maps the domain root at the default stage, so paths are unprefixed:
      // https://<api domain>/interrail/manifest
      defaultDomainMapping: { domainName: apiDomainName },
      corsPreflight: {
        allowOrigins: ALLOWED_ORIGINS,
        allowMethods: [apigwv2.CorsHttpMethod.GET, apigwv2.CorsHttpMethod.OPTIONS],
        allowHeaders: ['Content-Type'],
        maxAge: cdk.Duration.days(1),
      },
    });

    // Each handler owns a subpath. Mangum strips the /interrail prefix, so the
    // app itself serves /manifest, /stations and /departures.
    //
    // Methods are listed explicitly rather than using ANY: ANY also matches
    // OPTIONS, which sends preflights to the Lambda instead of letting API
    // Gateway answer them from the CORS config above. Add methods here as the
    // handler grows, but never OPTIONS.
    api.addRoutes({
      path: '/interrail/{proxy+}',
      methods: [apigwv2.HttpMethod.GET],
      integration: new apigwv2Integrations.HttpLambdaIntegration(
        'InterrailIntegration',
        interrailFunction,
      ),
    });

    // Route 53 does not support ALIAS to external hostnames, so we use A/AAAA
    // records pointing to the GitLab Pages server (utility-website.pages.dylanw.dev).
    new route53.ARecord(this, 'FrontendARecord', {
      zone: hostedZone,
      target: route53.RecordTarget.fromIpAddresses('51.38.73.143'),
    });

    new cdk.CfnOutput(this, 'HostedZoneNameServers', {
      description: `NS records to delegate ${BASE_DOMAIN} to Route 53`,
      value: cdk.Fn.join(', ', hostedZone.hostedZoneNameServers!),
    });

    new cdk.CfnOutput(this, 'ArtifactsBucketName', {
      value: artifactsBucket.bucketName,
    });

    new cdk.CfnOutput(this, 'ApiEndpoint', {
      description: 'Base URL of the API, e.g. <endpoint>/interrail/manifest',
      value: `https://${API_DOMAIN_NAME}`,
    });

    new cdk.CfnOutput(this, 'ApiDefaultEndpoint', {
      description: 'Execute-api URL backing the custom domain, for debugging',
      value: api.apiEndpoint,
    });
  }
}
