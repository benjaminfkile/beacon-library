// Fakes a consumer's own tests import: a scripted HubClient and a recording
// REST client that also serves an in-memory versioned state document with the
// API's conflict rule (a PUT lands only when expectedVersion is the current
// version). Nothing in this file imports vitest or any dev dependency, so a
// test runner in a consumer repository (or a plain Node script) can use them
// without pulling in this library's test tooling.

import type { HubClient } from "./hub.js";
import type {
  GetStateResponse,
  HeartbeatBody,
  HeartbeatResponse,
  LocationBody,
  LocationResponse,
  PutStateResponse,
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

export interface StateCall {
  method: "get" | "put";
  state?: object;
  expectedVersion?: number;
}

// A scripted heartbeat answer; stateVersion defaults to the fake's current
// document version when left out.
export type ScriptedHeartbeat =
  | (Omit<HeartbeatResponse, "stateVersion"> & { stateVersion?: number | null })
  | RestError;

export interface FakeRest extends Rest {
  locationCalls: LocationCall[];
  heartbeatCalls: HeartbeatCall[];
  stateCalls: StateCall[];
  // The stored document (null before the first write) and its version.
  state: Record<string, unknown> | null;
  stateVersion: number;
  nextLocation: (r: LocationResponse | RestError) => void;
  nextHeartbeat: (r: ScriptedHeartbeat) => void;
  // The next getState or putState call answers this error instead.
  nextStateError: (r: RestError) => void;
  // Another instance writes the document: stores a copy at `version`.
  setState: (state: Record<string, unknown> | null, version: number) => void;
}

export function createFakeRest(now: () => number = Date.now): FakeRest {
  const locationCalls: LocationCall[] = [];
  const heartbeatCalls: HeartbeatCall[] = [];
  const stateCalls: StateCall[] = [];
  const locQueue: Array<LocationResponse | RestError> = [];
  const hbQueue: ScriptedHeartbeat[] = [];
  const stateErrors: RestError[] = [];
  let updatedAt: string | null = null;

  const fake: FakeRest = {
    locationCalls,
    heartbeatCalls,
    stateCalls,
    state: null,
    stateVersion: 0,
    nextLocation(r) {
      locQueue.push(r);
    },
    nextHeartbeat(r) {
      hbQueue.push(r);
    },
    nextStateError(r) {
      stateErrors.push(r);
    },
    setState(state, version) {
      fake.state = state === null ? null : structuredClone(state);
      fake.stateVersion = version;
      updatedAt = new Date(now()).toISOString();
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
        return {
          ...r,
          stateVersion: r.stateVersion === undefined ? fake.stateVersion : r.stateVersion,
          tSendMs: now() - 50,
          tReceiveMs: now() + 50,
        };
      }
      return r;
    },
    async getState(): Promise<GetStateResponse | RestError> {
      stateCalls.push({ method: "get" });
      const err = stateErrors.shift();
      if (err) return err;
      return {
        ok: true,
        status: 200,
        state: fake.state === null ? null : structuredClone(fake.state),
        stateVersion: fake.stateVersion,
        updatedAt,
        serverTime: new Date(now()).toISOString(),
      };
    },
    async putState(state, expectedVersion): Promise<PutStateResponse | RestError> {
      stateCalls.push({ method: "put", state: structuredClone(state), expectedVersion });
      const err = stateErrors.shift();
      if (err) return err;
      const serverTime = new Date(now()).toISOString();
      if (expectedVersion !== fake.stateVersion) {
        return {
          ok: false,
          status: 409,
          code: "state_version_conflict",
          message: "the state document has a newer version",
          requestId: null,
          serverTime: null,
          currentVersion: fake.stateVersion,
        };
      }
      fake.state = structuredClone(state) as Record<string, unknown>;
      fake.stateVersion += 1;
      updatedAt = serverTime;
      return {
        ok: true,
        status: 200,
        stateVersion: fake.stateVersion,
        updatedAt,
        serverTime,
      };
    },
  };
  return fake;
}
