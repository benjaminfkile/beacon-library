// One HubConnection per beacon: WebSockets only, negotiation skipped,
// keep-alive 15 s, timeout 30 s, no automatic reconnect (the socket loop owns
// reconnect). Wrapped behind HubClient so tests can substitute a fake.
//
// The SignalR Node client refuses a ws://* or wss://* URL ("Cannot resolve …")
// even though the browser client accepts them; the WebSocket transport it
// picks internally handles the ws upgrade itself. Map the scheme back to
// http/https here so a `wss://` hub URL (what the docs and secrets carry)
// still works. Transport stays WebSockets only, negotiation still skipped.

import {
  HubConnection,
  HubConnectionBuilder,
  HttpTransportType,
  LogLevel,
} from "@microsoft/signalr";

export interface HubClient {
  start(): Promise<void>;
  stop(): Promise<void>;
  invoke<T = unknown>(method: string, ...args: unknown[]): Promise<T>;
  on(method: string, handler: (...args: unknown[]) => void): void;
  off(method: string, handler: (...args: unknown[]) => void): void;
  onClose(handler: (err?: Error) => void): void;
}

export interface HubOptions {
  hubUrl: string;
  key: string;
}

export function mapHubUrlForNode(hubUrl: string): string {
  if (hubUrl.startsWith("wss://")) return `https://${hubUrl.slice("wss://".length)}`;
  if (hubUrl.startsWith("ws://")) return `http://${hubUrl.slice("ws://".length)}`;
  return hubUrl;
}

export function buildHubClient(opts: HubOptions): HubClient {
  const url = mapHubUrlForNode(opts.hubUrl);
  const conn: HubConnection = new HubConnectionBuilder()
    .withUrl(url, {
      transport: HttpTransportType.WebSockets,
      skipNegotiation: true,
      accessTokenFactory: () => opts.key,
    })
    .withKeepAliveInterval(15_000)
    .withServerTimeout(30_000)
    .configureLogging(LogLevel.Warning)
    .build();
  // No .withAutomaticReconnect(): reconnect belongs to the socket loop.
  return {
    start: () => conn.start(),
    stop: () => conn.stop(),
    invoke: <T,>(method: string, ...args: unknown[]) => conn.invoke<T>(method, ...args),
    on: (method, handler) => conn.on(method, handler),
    off: (method, handler) => conn.off(method, handler),
    onClose: (handler) => conn.onclose((err) => handler(err ?? undefined)),
  };
}
