import * as cdk from 'aws-cdk-lib'
import { AppSyncAuthorizationType, EventApi } from 'aws-cdk-lib/aws-appsync'
import { Runtime } from 'aws-cdk-lib/aws-lambda'
import * as Nodejs from 'aws-cdk-lib/aws-lambda-nodejs'

import type { Construct } from 'constructs'

export class StockTickerBackendStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props)

    const apiKeyProvider = {
      authorizationType: AppSyncAuthorizationType.API_KEY,
    }

    // create an API called `my-event-api` that uses API Key authorization
    const api = new EventApi(this, 'api', {
      apiName: 'my-ticker-event-api',
      authorizationConfig: { authProviders: [apiKeyProvider] },
    })

    // add a channel namespace called `default`
    api.addChannelNamespace('stocks')

    new Nodejs.NodejsFunction(this, 'publisher', {
      runtime: Runtime.NODEJS_22_X,
      timeout: cdk.Duration.minutes(3),
      environment: {
        HTTP_ENDPOINT: api.httpDns,
        REAL_ENDPOINT: api.realtimeDns,
        API_KEY: api.apiKeys.Default.attrApiKey,
        WAIT_TIME: '1',
      },
    })

    // output configuration properties
    new cdk.CfnOutput(this, 'apiKey', {
      value: api.apiKeys.Default.attrApiKey,
    })
    new cdk.CfnOutput(this, 'httpDomain', { value: api.httpDns })
    new cdk.CfnOutput(this, 'realtimeDomain', { value: api.realtimeDns })
  }
}
