// Facade tests: createBeacon wires the three loops and survives stop/start;
// gateOnLeader serialises leader transitions on one promise chain. Nothing
// here opens a real socket or makes a real HTTP request.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBeacon, gateOnLeader } from "../src/beacon.js";
import type { BeaconLogger } from "../src/logger.js";
import type { HubClient, HubOptions } from "../src/hub.js";
import { setLatestFix } from "../src/state.js";
import { FakeHubClient } from "../src/testing.js";

// A structurally pino-like logger is assignable to BeaconLogger without a
// wrapper. This is a compile-time assertion: the file will not typecheck if
// the shape drifts.
interface PinoLike {
  info(obj: object, msg?: string, ...args: unknown[]): void;
  warn(obj: object, msg?: string, ...args: unknown[]): void;
  error(obj: object, msg?: string, ...args: unknown[]): void;
  fatal(obj: object, msg?: string, ...args: unknown[]): void;
  debug(obj: object, msg?: string, ...args: unknown[]): void;
  trace(obj: object, msg?: string, ...args: unknown[]): void;
  child(bindings: Record<string, unknown>): PinoLike;
}
const _pinoLike = {} as PinoLike;
const _asBeaconLogger: BeaconLogger = _pinoLike;
void _asBeaconLogger;

interface LogLine {
  level: "info" | "warn" | "error";
  fields: Record<string, unknown>;
  msg: string;
}

function makeLog(): { lines: LogLine[]; log: BeaconLogger } {
  const lines: LogLine[] = [];
  return {
    lines,
    log: {
      info: (fields, msg) => lines.push({ level: "info", fields, msg }),
      warn: (fields, msg) => lines.push({ level: "warn", fields, msg }),
      error: (fields, msg) => lines.push({ level: "error", fields, msg }),
    },
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

async function waitRunning(beacon: { state: { socketState: string } }): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (beacon.state.socketState === "connected") return;
    await Promise.resolve();
  }
}

interface FakeFetchLine {
  isLeader: boolean;
  evaluatedAtMsFromNow: number | null;
}

function scriptedFetch(now: () => number, entries: FakeFetchLine[]): typeof fetch {
  let i = 0;
  return (async () => {
    const e = entries[i++];
    if (!e) throw new Error("no scripted response");
    const evaluatedAt =
      e.evaluatedAtMsFromNow == null ? null : new Date(now() + e.evaluatedAtMsFromNow).toISOString();
    return new Response(JSON.stringify({ isLeader: e.isLeader, evaluatedAt }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

const FIX = {
  lat: 46.87,
  lng: -114,
  recordedAt: "2026-12-22T01:31:07.000Z",
  speedMps: 1,
  altitudeM: 100,
  headingDeg: 0,
  accuracyM: 10,
};

interface Ctx {
  hubs: FakeHubClient[];
  buildCount: number;
  buildBehavior: "ok" | "throwOnce" | "throwForever";
  logCtx: { lines: LogLine[]; log: BeaconLogger };
  fetchCalls: Array<{ url: string; init?: RequestInit }>;
  fetchImpl: typeof fetch;
}

function mkCtx(): Ctx {
  const ctx: Partial<Ctx> = {
    hubs: [],
    buildCount: 0,
    buildBehavior: "ok",
    logCtx: makeLog(),
    fetchCalls: [],
  };
  ctx.fetchImpl = (async (input, init) => {
    const url = typeof input === "string" ? input : (input as URL | Request).toString();
    ctx.fetchCalls!.push({ url, ...(init ? { init } : {}) });
    return new Response(
      JSON.stringify({
        ok: true,
        receivedAt: new Date().toISOString(),
        liveEventId: null,
        isActive: true,
        serverTime: new Date().toISOString(),
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  return ctx as Ctx;
}

function makeBeacon(ctx: Ctx): ReturnType<typeof createBeacon> {
  const buildHub = (_o: HubOptions): HubClient => {
    ctx.buildCount += 1;
    if (ctx.buildBehavior === "throwForever") throw new Error("build failed");
    if (ctx.buildBehavior === "throwOnce" && ctx.buildCount === 1)
      throw new Error("build failed once");
    const h = new FakeHubClient();
    ctx.hubs.push(h);
    return h;
  };
  return createBeacon({
    apiBaseUrl: "https://api.example",
    beaconKey: "wbk_x",
    hubUrl: "wss://gateway.example/hub",
    ingestChannel: "x:ingest",
    log: ctx.logCtx.log,
    buildHealth: () => ({ batteryPercent: null, lastFixAgeS: null, socketState: "connected" }),
    buildDebug: () => ({ note: "test" }),
    buildHub,
    fetchImpl: ctx.fetchImpl,
  });
}

describe("createBeacon", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("start is idempotent: one 'starting beacon core' line, one socket loop", async () => {
    const ctx = mkCtx();
    const b = makeBeacon(ctx);
    b.start();
    b.start();
    b.start();
    await flush();
    const startLines = ctx.logCtx.lines.filter((l) => l.msg === "starting beacon core");
    expect(startLines).toHaveLength(1);
    expect(ctx.hubs.length).toBe(1);
    await b.stop();
  });

  it("stop is idempotent: one 'stopping beacon core' line", async () => {
    const ctx = mkCtx();
    const b = makeBeacon(ctx);
    b.start();
    await flush();
    await b.stop();
    await b.stop();
    await b.stop();
    const stopLines = ctx.logCtx.lines.filter((l) => l.msg === "stopping beacon core");
    expect(stopLines).toHaveLength(1);
  });

  it("stop is ordered: send loop and heartbeat loop stop before the socket does", async () => {
    const ctx = mkCtx();
    const b = makeBeacon(ctx);
    b.start();
    await flush();
    expect(b.running()).toBe(true);
    const hub = ctx.hubs[0]!;

    let release!: () => void;
    hub.stop = () =>
      new Promise<void>((r) => {
        release = r;
      });

    const stopP = b.stop();
    await flush();

    setLatestFix(b.state, FIX);
    b.wake();
    await vi.advanceTimersByTimeAsync(50);
    const sends = hub.invokes.filter((i) => i.method === "SendToChannel");
    expect(sends).toHaveLength(0);

    release();
    await stopP;
    expect(b.running()).toBe(false);
  });

  it("state and rest survive stop then start (same instances across cycles)", async () => {
    const ctx = mkCtx();
    const b = makeBeacon(ctx);
    const state1 = b.state;
    const rest1 = b.rest;

    b.start();
    await flush();
    setLatestFix(b.state, FIX);
    await b.stop();

    b.start();
    await flush();
    expect(b.state).toBe(state1);
    expect(b.rest).toBe(rest1);
    expect(state1.nextSeqLocal).toBe(2);
    await b.stop();
  });

  it("wake() while connected: a fix reaches the fake hub", async () => {
    const ctx = mkCtx();
    const b = makeBeacon(ctx);
    b.start();
    await flush();
    expect(b.running()).toBe(true);

    setLatestFix(b.state, FIX);
    b.wake();
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    const hub = ctx.hubs[0]!;
    const sends = hub.invokes.filter((i) => i.method === "SendToChannel");
    expect(sends).toHaveLength(1);
    expect(sends[0]!.args[0]).toBe("x:ingest");
    expect(sends[0]!.args[1]).toBe("location");

    await b.stop();
  });

  it("a start() issued while a stop is still in flight keeps its own hub", async () => {
    const ctx = mkCtx();
    const b = makeBeacon(ctx);
    b.start();
    await flush();
    expect(b.running()).toBe(true);

    const stopping = b.stop();
    b.start();
    await stopping;
    await flush();
    expect(b.running()).toBe(true);
    expect(ctx.hubs).toHaveLength(2);

    setLatestFix(b.state, FIX);
    b.wake();
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    const sends = ctx.hubs[1]!.invokes.filter((i) => i.method === "SendToChannel");
    expect(sends).toHaveLength(1);

    await b.stop();
  });

  it("wake() while the socket is down: a fix reaches the fake REST", async () => {
    const ctx = mkCtx();
    const b = makeBeacon(ctx);
    b.start();
    await flush();
    expect(b.running()).toBe(true);

    b.state.socketState = "reconnecting";
    setLatestFix(b.state, FIX);
    b.wake();
    await vi.advanceTimersByTimeAsync(10);
    await flush();
    const posts = ctx.fetchCalls.filter((c) => c.url.endsWith("/locations"));
    expect(posts.length).toBeGreaterThanOrEqual(1);

    await b.stop();
  });

  it("wake() while stopped is a no-op and does not throw", async () => {
    const ctx = mkCtx();
    const b = makeBeacon(ctx);
    expect(() => b.wake()).not.toThrow();
    b.start();
    await flush();
    await b.stop();
    expect(() => b.wake()).not.toThrow();
    await vi.advanceTimersByTimeAsync(100);
    const hubCalls = (ctx.hubs[0]?.invokes ?? []).filter((i) => i.method === "SendToChannel");
    expect(hubCalls).toHaveLength(0);
  });

  it("three hub rejections while connected with a live event trigger one rejoin()", async () => {
    const ctx = mkCtx();
    const b = makeBeacon(ctx);
    b.start();
    await flush();
    const hub = ctx.hubs[0]!;
    expect(b.state.socketState).toBe("connected");
    b.state.lastHeartbeat = { receivedAt: "", liveEventId: 7, isActive: true };

    for (let i = 0; i < 3; i++) {
      setLatestFix(b.state, FIX);
      b.wake();
      await vi.advanceTimersByTimeAsync(1);
      await flush();
      const last = hub.invokes[hub.invokes.length - 1]!;
      expect(last.method).toBe("SendToChannel");
      last.reject(new Error("rejected"));
      await flush();
    }

    await flush();
    expect(b.state.rejoinCount).toBe(1);

    await b.stop();
  });

  it("a hub build error is logged at warn and the loop retries", async () => {
    const ctx = mkCtx();
    ctx.buildBehavior = "throwOnce";
    const b = makeBeacon(ctx);
    b.start();
    await flush();

    const warns = ctx.logCtx.lines.filter(
      (l) => l.level === "warn" && l.msg === "hub build failed; backing off",
    );
    expect(warns.length).toBe(1);
    expect(warns[0]!.fields.err).toContain("build failed once");

    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(ctx.buildCount).toBeGreaterThanOrEqual(2);
    expect(b.state.socketState).toBe("connected");

    await b.stop();
  });
});

describe("gateOnLeader", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts the beacon on leader and stops it on follower", async () => {
    const ctx = mkCtx();
    const b = makeBeacon(ctx);
    const { lines, log } = makeLog();
    const now = () => 1_000_000;
    const leader = gateOnLeader({
      leader: {
        gatewayInternalUrl: "http://gateway",
        realtimeToken: "grt_x",
        autoStart: false,
        now,
        fetchImpl: scriptedFetch(now, [
          { isLeader: true, evaluatedAtMsFromNow: -1000 },
          { isLeader: false, evaluatedAtMsFromNow: -1000 },
        ]),
      },
      beacon: b,
      log,
    });

    await leader.pollOnce();
    await flush();
    expect(b.running()).toBe(true);
    expect(lines.filter((l) => l.msg === "leader change" && l.fields.isLeader === true)).toHaveLength(
      1,
    );

    await leader.pollOnce();
    await flush();
    expect(b.running()).toBe(false);
    expect(
      lines.filter((l) => l.msg === "leader change" && l.fields.isLeader === false),
    ).toHaveLength(1);

    leader.stop();
  });

  it("serialises a follower change during a slow onStop: no start overlaps the stop", async () => {
    const ctx = mkCtx();
    const b = makeBeacon(ctx);
    const { log } = makeLog();
    const now = () => 2_000_000;
    let releaseStop!: () => void;
    const slowOnStop = () => new Promise<void>((r) => { releaseStop = r; });

    const leader = gateOnLeader({
      leader: {
        gatewayInternalUrl: "http://gateway",
        realtimeToken: "grt_x",
        autoStart: false,
        now,
        fetchImpl: scriptedFetch(now, [
          { isLeader: true, evaluatedAtMsFromNow: -1000 },
          { isLeader: false, evaluatedAtMsFromNow: -1000 },
          { isLeader: true, evaluatedAtMsFromNow: -1000 },
        ]),
      },
      beacon: b,
      onStop: slowOnStop,
      log,
    });

    await leader.pollOnce();
    await flush();
    expect(b.running()).toBe(true);

    await leader.pollOnce();
    await flush();
    expect(b.running()).toBe(true);

    await leader.pollOnce();
    await flush();
    expect(b.running()).toBe(true);

    releaseStop();
    await flush();
    expect(b.running()).toBe(true);

    leader.stop();
    await b.stop();
  });

  it("ends in the state of the last change after a rapid true, false, true sequence", async () => {
    const ctx = mkCtx();
    const b = makeBeacon(ctx);
    const { log } = makeLog();
    const now = () => 3_000_000;
    const leader = gateOnLeader({
      leader: {
        gatewayInternalUrl: "http://gateway",
        realtimeToken: "grt_x",
        autoStart: false,
        now,
        fetchImpl: scriptedFetch(now, [
          { isLeader: true, evaluatedAtMsFromNow: -1000 },
          { isLeader: false, evaluatedAtMsFromNow: -1000 },
          { isLeader: true, evaluatedAtMsFromNow: -1000 },
        ]),
      },
      beacon: b,
      log,
    });

    await leader.pollOnce();
    await leader.pollOnce();
    await leader.pollOnce();
    await flush();

    expect(b.running()).toBe(true);
    leader.stop();
    await b.stop();
  });

  it("survives onStart throwing: the error is logged and the chain continues", async () => {
    const ctx = mkCtx();
    const b = makeBeacon(ctx);
    const { lines, log } = makeLog();
    const now = () => 4_000_000;
    const leader = gateOnLeader({
      leader: {
        gatewayInternalUrl: "http://gateway",
        realtimeToken: "grt_x",
        autoStart: false,
        now,
        fetchImpl: scriptedFetch(now, [
          { isLeader: true, evaluatedAtMsFromNow: -1000 },
          { isLeader: false, evaluatedAtMsFromNow: -1000 },
        ]),
      },
      beacon: b,
      onStart: () => {
        throw new Error("onStart boom");
      },
      log,
    });

    await leader.pollOnce();
    await flush();
    expect(b.running()).toBe(true);
    const errs = lines.filter((l) => l.level === "error");
    expect(errs.length).toBe(1);
    expect(errs[0]!.fields.err).toContain("onStart boom");

    await leader.pollOnce();
    await flush();
    expect(b.running()).toBe(false);

    leader.stop();
  });

  it("a stop that rejects is logged and later leadership changes still apply", async () => {
    const { lines, log } = makeLog();
    let starts = 0;
    let stops = 0;
    let running = false;
    const base = makeBeacon(mkCtx());
    const beacon = {
      ...base,
      start: () => {
        starts += 1;
        running = true;
      },
      stop: async () => {
        stops += 1;
        running = false;
        if (stops === 1) throw new Error("stop failed");
      },
      running: () => running,
    };
    const now = () => 1_000_000;
    const leader = gateOnLeader({
      leader: {
        gatewayInternalUrl: "http://gateway",
        realtimeToken: "grt_x",
        autoStart: false,
        now,
        fetchImpl: scriptedFetch(now, [
          { isLeader: true, evaluatedAtMsFromNow: -1000 },
          { isLeader: false, evaluatedAtMsFromNow: -1000 },
          { isLeader: true, evaluatedAtMsFromNow: -1000 },
        ]),
      },
      beacon,
      log,
    });

    await leader.pollOnce();
    await flush();
    await leader.pollOnce();
    await flush();
    await leader.pollOnce();
    await flush();

    expect(starts).toBe(2);
    expect(stops).toBe(1);
    expect(beacon.running()).toBe(true);
    const failed = lines.filter((l) => l.level === "error" && l.msg === "leader transition failed");
    expect(failed).toHaveLength(1);
    expect(String(failed[0]!.fields.err)).toMatch(/stop failed/);

    leader.stop();
  });
});
