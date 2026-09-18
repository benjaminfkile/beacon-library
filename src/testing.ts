// Fakes a consumer's own tests import: a scripted HubClient and a recording
// REST client. Nothing in this file imports vitest or any dev dependency, so a
// test runner in a consumer repository (or a plain Node script) can use them
// without pulling in this library's test tooling.

import type { HubClient } from "./hub.js";
import type {
  HeartbeatBody,
  HeartbeatResponse,
  LocationBody,
  LocationResponse,
  Rest,
  RestError,
} from "./rest.js";

export interface HubInvoke {
  method: string;
  args: unknown[];
  resolve: (value?: unknown) => void;
  reject: (err: Error) => void;
}

export class FakeHubClient implements HubClient {
  public started = false;
  public stopped = false;
  public invokes: HubInvoke[] = [];
  public listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  public closeHandlers: Array<(err?: Error) => void> = [];
  public startBehavior: "ok" | "throw" = "ok";
  public startError: Error | null = null;
  public joinBehavior: "ok" | "throw" | "denied" = "ok";
  public joinError: Error | null = null;

  async start(): Promise<void> {
    this.started = true;
    if (this.startBehavior === "throw") throw this.startError ?? new Error("start failed");
  }
  async stop(): Promise<void> {
    this.stopped = true;
  }
  invoke<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
    if (method === "JoinPrivateChannel") {
      if (this.joinBehavior === "denied") return Promise.reject(this.joinError ?? new Error("join denied"));
      if (this.joinBehavior === "throw") return Promise.reject(this.joinError ?? new Error("join failed"));
      return Promise.resolve(undefined as unknown as T);
    }
    return new Promise<T>((resolve, reject) => {
      this.invokes.push({
        method,
        args,
        resolve: resolve as (v?: unknown) => void,
        reject,
      });
    });
  }
  on(method: string, handler: (...args: unknown[]) => void): void {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method)!.add(handler);
  }
  off(method: string, handler: (...args: unknown[]) => void): void {
    this.listeners.get(method)?.delete(handler);
  }
  onClose(handler: (err?: Error) => void): void {
    this.closeHandlers.push(handler);
  }
  emit(method: string, ...args: unknown[]): void {
    for (const h of this.listeners.get(method) ?? []) h(...args);
  }
  triggerClose(err?: Error): void {
    for (const h of this.closeHandlers) h(err);
  }
  lastInvoke(): HubInvoke | undefined {
    return this.invokes[this.invokes.length - 1];
  }
}

export interface LocationCall {
  body: LocationBody;
}
export interface HeartbeatCall {
  body: HeartbeatBody;
}

export interface FakeRest extends Rest {
  locationCalls: LocationCall[];
  heartbeatCalls: HeartbeatCall[];
  nextLocation: (r: LocationResponse | RestError) => void;
  nextHeartbeat: (r: HeartbeatResponse | RestError) => void;
}

export function createFakeRest(now: () => number = Date.now): FakeRest {
  const locationCalls: LocationCall[] = [];
  const heartbeatCalls: HeartbeatCall[] = [];
  const locQueue: Array<LocationResponse | RestError> = [];
  const hbQueue: Array<HeartbeatResponse | RestError> = [];

  return {
    locationCalls,
    heartbeatCalls,
    nextLocation(r) {
      locQueue.push(r);
    },
    nextHeartbeat(r) {
      hbQueue.push(r);
    },
    async postLocation(body) {
      locationCalls.push({ body });
      const r = locQueue.shift();
      if (!r) {
        return {
          ok: false,
          status: null,
          code: null,
          message: null,
          requestId: null,
          serverTime: null,
          transportError: "no scripted response",
        };
      }
      return r;
    },
    async postHeartbeat(body) {
      heartbeatCalls.push({ body });
      const r = hbQueue.shift();
      if (!r) {
        return {
          ok: false,
          status: null,
          code: null,
          message: null,
          requestId: null,
          serverTime: null,
          transportError: "no scripted response",
        };
      }
      if (r.ok) {
        return { ...r, tSendMs: now() - 50, tReceiveMs: now() + 50 };
      }
      return r;
    },
  };
}
