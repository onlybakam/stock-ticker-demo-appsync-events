const AWS_APPSYNC_EVENTS_SUBPROTOCOL = 'aws-appsync-event-ws'

interface ClientOptions {
  region?: string
  auth:
    | { mode: 'apiKey'; apiKey: string }
    | {
        mode: 'COGNITO_USER_POOLS' | 'OIDC' | 'CUSTOM'
        authorization: string
      }
}

export type UnsubResp = {
  unsubscribe: () => void
}
interface Subscription {
  callback: (data: unknown) => void
  ready: boolean
  channel: string
  timestamp: number
  resolve: (value: UnsubResp) => void
  reject: (reason?: unknown) => unknown
}

type AuthProtocol = { 'x-api-key': string } | { authorization: string }
type ConnectAuthProtocol =
  | { 'x-api-key': string; host: string }
  | { authorization: string; host: string }

type ProtocolMessage =
  | ProtocolMessage.KaMessage
  | ProtocolMessage.ConnectionInitMessage
  | ProtocolMessage.ConnectionAckMessage
  | ProtocolMessage.SubscribeMessage
  | ProtocolMessage.SubscribeSuccessMessage
  | ProtocolMessage.SubscribeErrorMessage
  | ProtocolMessage.UnsubscribeMessage
  | ProtocolMessage.UnsubscribeErrorMessage
  | ProtocolMessage.UnsubscribeSuccessMessage
  | ProtocolMessage.UnsubscribeErrorMessage
  | ProtocolMessage.DataMessage
  | ProtocolMessage.PublishMessage
  | ProtocolMessage.PublishSuccessMessage
  | ProtocolMessage.PublishErrorMessage
  | ProtocolMessage.ErrorMessage

export namespace ProtocolMessage {
  export interface KaMessage {
    type: 'ka'
  }
  export interface ConnectionInitMessage {
    type: 'connection_init'
  }
  export interface ConnectionAckMessage {
    type: 'connection_ack'
    connectionTimeoutMs: number
  }
  export interface SubscribeMessage {
    type: 'subscribe'
    id: string
    channel: string
    authorization: AuthProtocol
  }
  export interface SubscribeSuccessMessage {
    type: 'subscribe_success'
    id: string
  }
  export interface SubscribeErrorMessage {
    type: 'subscribe_error'
    id: string
    errors?: ProtocolError[]
  }
  export interface UnsubscribeMessage {
    type: 'unsubscribe'
    id: string
  }
  export interface UnsubscribeSuccessMessage {
    type: 'unsubscribe_success'
    id: string
  }
  export interface UnsubscribeErrorMessage {
    type: 'unsubscribe_error'
    id: string
    errors?: ProtocolError[]
  }
  export interface DataMessage {
    type: 'data'
    id: string
    event: string
  }
  export interface PublishMessage {
    type: 'publish'
    id: string
    channel: string
    events: string[]
    authorization: AuthProtocol
  }
  export interface PublishSuccessMessage {
    type: 'publish_success'
    id: string
    successful: { identifier: string; index: number }[]
    failed: { identifier: string; index: number }[]
  }
  export interface PublishErrorMessage {
    type: 'publish_error'
    id: string
    errors: ProtocolError[]
  }
  export interface ErrorMessage {
    type: 'error'
    id?: string
    errors?: ProtocolError[]
  }
}

interface ProtocolError {
  errorType: string
  message: string
}

/**
 * Returns a header value for the SubProtocol header
 */
function getAuthProtocol(auth: ConnectAuthProtocol): string {
  const based64UrlHeader = btoa(JSON.stringify(auth))
    .replace(/\+/g, '-') // Convert '+' to '-'
    .replace(/\//g, '_') // Convert '/' to '_'
    .replace(/=+$/, '') // Remove padding `=`
  return `header-${based64UrlHeader}`
}

export class AppSyncEventsClient {
  private ws: WebSocket | null
  private subscriptions: Map<string, Subscription>
  private isConnected: boolean
  private reconnectAttempts: number
  private readonly maxReconnectAttempts: number
  private readonly reconnectDelay: number
  private connection: Promise<AppSyncEventsClient> | null = null
  private options: ClientOptions
  private httpEndpoint: string
  private realTimeEndpoint: string

  constructor(url: string, options: ClientOptions) {
    this.httpEndpoint = url
    this.realTimeEndpoint = getRealtimeEndpointUrl(url)
    this.validateOptions(options)
    this.options = options

    this.ws = null
    this.subscriptions = new Map()
    this.isConnected = false
    this.reconnectAttempts = 0
    this.maxReconnectAttempts = 5
    this.reconnectDelay = 1000 // Start with 1 second delay
  }

  private validateOptions(options: ClientOptions): void {
    if (!options.auth) {
      throw new Error('You must specify an auth configuration')
    }
    const authMode = options.auth.mode
    if (!authMode) {
      throw new Error('Auth mode required')
    }
    if (authMode === 'apiKey') {
      if (!options.auth.apiKey) {
        throw new Error('Invalid auth configuration.')
      }
      return
    }
    if (
      (authMode === 'COGNITO_USER_POOLS' || authMode === 'OIDC' || authMode === 'CUSTOM') &&
      !options.auth.authorization
    ) {
      throw new Error('Invalid authMode. Unexpected `authorization`.')
    }
  }

  private getAuthHeaders() {
    const authMode = this.options.auth.mode
    if (authMode === 'apiKey') {
      return { 'x-api-key': this.options.auth.apiKey }
    }
    if (authMode === 'COGNITO_USER_POOLS' || authMode === 'OIDC' || authMode === 'CUSTOM') {
      return { authorization: this.options.auth.authorization }
    }
    throw new Error('should not happen')
  }

  public connect(): Promise<AppSyncEventsClient> {
    if (this.connection) {
      return this.connection
    }
    this.connection = new Promise((resolve, reject) => {
      try {
        const header = getAuthProtocol({
          host: new URL(this.httpEndpoint).hostname,
          ...this.getAuthHeaders(),
        })
        this.ws = new WebSocket(this.realTimeEndpoint, [AWS_APPSYNC_EVENTS_SUBPROTOCOL, header])

        this.ws.onopen = () => {
          console.log('WebSocket connection established', this.ws?.readyState)
          if (this.ws?.readyState === WebSocket.OPEN) {
            this.isConnected = true
            this.reconnectAttempts = 0
            resolve(this)
          }
        }

        this.ws.onclose = () => {
          console.log('WebSocket connection closed')
          this.isConnected = false
          this.handleReconnect()
        }

        this.ws.onerror = (error: Event) => {
          console.error('WebSocket error:', error)
          reject(error)
        }

        this.ws.onmessage = (event: MessageEvent) => {
          try {
            const message = JSON.parse(event.data) as ProtocolMessage
            if (message.type === 'data') {
              this.handleData(message)
            } else if (message.type === 'subscribe_success') {
              this.handleSubscribeSuccess(message)
            } else if (message.type === 'subscribe_error') {
              this.handlerSubscribeError(message)
            } else if (message.type === 'error') {
              this.handleError(message)
            }
          } catch (error) {
            console.error('Error parsing message:', error)
          }
        }
      } catch (error) {
        reject(error)
      }
    })
    return this.connection
  }

  private handleReconnect(): void {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++
      const delay = this.reconnectDelay * 2 ** (this.reconnectAttempts - 1)
      console.log(`Attempting to reconnect in ${delay}ms...`)

      setTimeout(() => {
        this.connect().catch((error) => console.error('Reconnection failed:', error))
      }, delay)
    } else {
      console.error('Max reconnection attempts reached')
    }
  }

  private handleError(message: ProtocolMessage.ErrorMessage) {
    console.log('Unexpected error', message)
  }

  private handlerSubscribeError(message: ProtocolMessage.SubscribeErrorMessage) {
    const subscription = this.subscriptions.get(message.id)
    if (!subscription) {
      return
    }
    console.log(`Error subscribing to channel ${subscription.channel}`)
    subscription.reject(message.errors)
    this.subscriptions.delete(message.id)
  }

  private handleSubscribeSuccess(message: ProtocolMessage.SubscribeSuccessMessage) {
    const subscription = this.subscriptions.get(message.id)
    if (!subscription) {
      return
    }
    console.log(`subscription ${message.id} ready`)
    subscription.ready = true
    subscription.resolve({ unsubscribe: () => this.unsubscribe(message.id) })
  }

  private handleData(message: ProtocolMessage.DataMessage): void {
    const subscription = this.subscriptions.get(message.id)
    if (!subscription || !subscription.ready) {
      console.error('Subscription not ready')
      return
    }
    subscription.callback(JSON.parse(message.event))
  }

  public publish(channel: string, data: unknown): void {
    if (!this.isConnected || !this.ws) {
      throw new Error('WebSocket is not connected')
    }

    const publishMessage: ProtocolMessage.PublishMessage = {
      id: crypto.randomUUID(),
      type: 'publish',
      channel,
      events: [JSON.stringify(data)],
      authorization: this.getAuthHeaders(),
    }

    this.ws.send(JSON.stringify(publishMessage))
  }

  public async subscribe(
    channel: string,
    callback: (data: unknown) => void,
    subscriptionId?: string,
  ) {
    await this.connect()
    return new Promise<UnsubResp>((resolve, reject) => {
      // const it = this.subscriptions.entries()
      // const sub = it.find(([id, s]) => {
      //   return s.channel === channel
      // })
      // if (sub) {
      //   resolve(sub)
      // }
      const id = subscriptionId ?? crypto.randomUUID()
      this.subscriptions.set(id, {
        callback,
        channel,
        resolve,
        reject,
        timestamp: Date.now(),
        ready: false,
      })
      const subscribeMessage: ProtocolMessage.SubscribeMessage = {
        type: 'subscribe',
        id,
        channel,
        authorization: this.getAuthHeaders(),
      }
      this.ws?.send(JSON.stringify(subscribeMessage))
    })
  }

  public unsubscribe(subscriptionId: string): void {
    if (!this.isConnected || !this.ws) {
      throw new Error('WebSocket is not connected')
    }

    const unsubscribeMessage: ProtocolMessage.UnsubscribeMessage = {
      type: 'unsubscribe',
      id: subscriptionId,
    }

    this.ws.send(JSON.stringify(unsubscribeMessage))
    this.subscriptions.delete(subscriptionId)
  }

  public disconnect(): void {
    if (this.ws) {
      this.ws.close()
      this.subscriptions.clear()
      this.isConnected = false
    }
  }
}

const protocol = 'wss://'
const eventDomainPattern =
  /^https:\/\/\w{26}\.\w+-api\.\w{2}(?:(?:-\w{2,})+)-\d\.amazonaws.com(?:\.cn)?\/event$/i
const customDomainPath = '/realtime'

export const isCustomDomain = (url: string): boolean => {
  return url.match(eventDomainPattern) === null
}

const isEventDomain = (url: string): boolean => url.match(eventDomainPattern) !== null

// export const useClient = (url: string, options: ClientOptions) => {
//   const client = new AppSyncEventsClient(url, options)
//   const cc = useRef<AppSyncEventsClient>(client)
//
//   useEffect(() => {
//     console.log('a dawn')
//     if (!cc.current) {
//       client.connect().then((_cc) => {
//         console.log('Lets ride')
//         cc.current = _cc
//       })
//     }
//     return () => {
//       console.log('kill')
//       cc.current?.disconnect()
//     }
//   }, [url])
//   return cc
// }

export const getRealtimeEndpointUrl = (endpoint: string | undefined) => {
  let realtimeEndpoint = endpoint ?? ''

  if (isEventDomain(realtimeEndpoint)) {
    realtimeEndpoint = realtimeEndpoint
      .replace('ddpg-api', 'grt-gamma')
      .replace('appsync-api', 'appsync-realtime-api')
  }
  realtimeEndpoint = realtimeEndpoint
    .replace('https://', protocol)
    .replace('http://', protocol)
    .concat(customDomainPath)

  return realtimeEndpoint
}
