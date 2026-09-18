// The socket loop's transitions per contracts 9.2: `connected` only on the
// `joined` ack; evictions; the 10 s denied wait; backoff never gives up.

import { describe, expect, it } from "vitest";
import { startSocketLoop } from "../src/socketLoop.js";
import { createBeaconState } from "../src/state.js";
import { FakeHubClient } from "./fakes.js";
import { BACKOFF_MS, JOIN_DENIED_FIRST_WAIT_MS, backoffMs } from "../src/backoff.js";

function yieldMacrotask(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}
async function drain(): Promise<void> {
  for (let i = 0; i < 10; i++) await yieldMacrotask();
}

describe("backoff", () => {
  it("is 1 s, 2 s, 3 s, 5 s, then 5 s forever (no maximum beyond that)", () => {
    expect(BACKOFF_MS).toEqual([1000, 2000, 3000, 5000]);
    expect(backoffMs(0)).toBe(1000);
    expect(backoffMs(3)).toBe(5000);
    expect(backoffMs(50)).toBe(5000);
    expect(backoffMs(1_000_000)).toBe(5000);
  });
});

describe("socket loop transitions", () => {
  it("becomes 'connected' only after JoinPrivateChannel resolves (the joined ack)", async () => {
    const state = createBeaconState();
    let hub!: FakeHubClient;
    let joinResolvers: Array<() => void> = [];
    class Slow extends FakeHubClient {
      constructor() {
        super();
      }
      override invoke<T = unknown>(method: string, ..._args: unknown[]): Promise<T> {
        if (method === "JoinPrivateChannel") {
          return new Promise<T>((resolve) => {
            joinResolvers.push(() => resolve(undefined as unknown as T));
          });
        }
        return super.invoke<T>(method, ..._args);
      }
    }
    const loop = startSocketLoop({
      build: () => (hub = new Slow()),
      ingestChannel: "x:ingest",
      key: "wbk_x",
      state,
      sleep: yieldMacrotask,
    });
    // Let start() resolve. The join is still pending, so state must be
    // "connecting", not "connected", until the join resolves.
    await drain();
    expect(state.socketState).toBe("connecting");
    joinResolvers.forEach((r) => r());
    await drain();
    expect(state.socketState).toBe("connected");
    await loop.stop();
    expect(state.socketState).toBe("disconnected");
  });

  it("waits 10 s on the first retry after JoinPrivateChannel is denied", async () => {
    const state = createBeaconState();
    const sleepCalls: number[] = [];
    let sleepCount = 0;
    const built: FakeHubClient[] = [];
    const loop = startSocketLoop({
      build: () => {
        const h = new FakeHubClient();
        // First build: denied. Second build: hangs on join so we don't loop.
        if (built.length === 0) {
          h.joinBehavior = "denied";
          h.joinError = new Error("join denied by gateway");
        }
        built.push(h);
        return h;
      },
      ingestChannel: "x:ingest",
      key: "wbk_x",
      state,
      sleep: async (ms) => {
        sleepCalls.push(ms);
        sleepCount += 1;
        // After the denied-wait sleep, stop the loop so the test finishes.
        if (sleepCount >= 1) await loop.stop();
      },
    });
    await drain();
    expect(sleepCalls[0]).toBe(JOIN_DENIED_FIRST_WAIT_MS);
  });

  it("survives a build() throw: reports, backs off, and retries", async () => {
    const state = createBeaconState();
    const sleepCalls: number[] = [];
    let buildCalls = 0;
    const buildErrors: unknown[] = [];
    let loopHandle!: { stop(): Promise<void> };
    loopHandle = startSocketLoop({
      build: () => {
        buildCalls += 1;
        if (buildCalls === 1) throw new Error("Cannot resolve wss://…");
        // Second build returns a working fake so the loop reaches "connected"
        // and we know the loop kept running after the first throw.
        return new FakeHubClient();
      },
      ingestChannel: "x:ingest",
      key: "wbk_x",
      state,
      onBuildError: (err) => buildErrors.push(err),
      sleep: async (ms) => {
        sleepCalls.push(ms);
        // Stop as soon as the second attempt has connected so the test ends.
        if (state.socketState === "connected") await loopHandle.stop();
      },
    });
    await drain();
    // The first attempt threw; the loop reported the error, waited backoffMs(0)
    // = 1000 ms, then built a working hub and reached "connected".
    expect(buildCalls).toBeGreaterThanOrEqual(2);
    expect(buildErrors.length).toBe(1);
    expect((buildErrors[0] as Error).message).toMatch(/Cannot resolve/);
    expect(sleepCalls[0]).toBe(1000);
    await loopHandle.stop();
    expect(state.socketState).toBe("disconnected");
  });
});

describe("hub ChannelEvent envelope routing (contracts 2.3, 9.2)", () => {
  // The gateway's one client method is `ChannelEvent`. The socket loop routes
  // envelopes on `envelope.channel` and `envelope.event`, and ignores anything
  // outside the ingest channel it joined.

  class CountingHub extends FakeHubClient {
    public joinCount = 0;
    override invoke<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
      if (method === "JoinPrivateChannel") {
        this.joinCount += 1;
        return Promise.resolve(undefined as unknown as T);
      }
      return super.invoke<T>(method, ...args);
    }
  }

  it("routes a 'joined' envelope on the ingest channel to 'connected' even before invoke resolves", async () => {
    const state = createBeaconState();
    let hub!: FakeHubClient;
    const joinResolvers: Array<() => void> = [];
    class Slow extends FakeHubClient {
      override invoke<T = unknown>(method: string, ..._args: unknown[]): Promise<T> {
        if (method === "JoinPrivateChannel") {
          return new Promise<T>((resolve) => {
            joinResolvers.push(() => resolve(undefined as unknown as T));
          });
        }
        return super.invoke<T>(method, ..._args);
      }
    }
    const loop = startSocketLoop({
      build: () => (hub = new Slow()),
      ingestChannel: "x:ingest",
      key: "wbk_x",
      state,
      sleep: yieldMacrotask,
    });
    await drain();
    expect(state.socketState).toBe("connecting");
    hub.emit("ChannelEvent", {
      channel: "x:ingest",
      event: "joined",
      data: { channel: "x:ingest" },
    });
    expect(state.socketState).toBe("connected");
    await loop.stop();
    expect(state.socketState).toBe("disconnected");
  });

  it("routes 'channelEvicted' with auth_expired: re-invokes JoinPrivateChannel and kicks the send loop; stays connected", async () => {
    const state = createBeaconState();
    let hub!: CountingHub;
    let connectedCount = 0;
    const loop = startSocketLoop({
      build: () => (hub = new CountingHub()),
      ingestChannel: "x:ingest",
      key: "wbk_x",
      state,
      onConnected: () => {
        connectedCount += 1;
      },
      sleep: yieldMacrotask,
    });
    await drain();
    expect(state.socketState).toBe("connected");
    expect(hub.joinCount).toBe(1);
    expect(connectedCount).toBe(1);

    hub.emit("ChannelEvent", {
      channel: "x:ingest",
      event: "channelEvicted",
      data: { channel: "x:ingest", reason: "auth_expired" },
    });
    await drain();

    // Re-joined on the same connection: JoinPrivateChannel invoked again,
    // onConnected (the send-loop kick) fired again, state stayed connected
    // throughout.
    expect(hub.joinCount).toBe(2);
    expect(connectedCount).toBe(2);
    expect(state.socketState).toBe("connected");

    await loop.stop();
    expect(state.socketState).toBe("disconnected");
  });

  it("routes 'channelEvicted' with any other reason through the normal reconnect path", async () => {
    const state = createBeaconState();
    let hub!: FakeHubClient;
    const loop = startSocketLoop({
      build: () => (hub = new FakeHubClient()),
      ingestChannel: "x:ingest",
      key: "wbk_x",
      state,
      sleep: yieldMacrotask,
    });
    await drain();
    expect(state.socketState).toBe("connected");
    hub.emit("ChannelEvent", {
      channel: "x:ingest",
      event: "channelEvicted",
      data: { channel: "x:ingest", reason: "service_removed" },
    });
    // The eviction stopped the current connection; the outer loop reconnects.
    await drain();
    expect(["connecting", "connected", "reconnecting"]).toContain(state.socketState);
    await loop.stop();
    expect(state.socketState).toBe("disconnected");
  });

  it("rejoin() re-invokes JoinPrivateChannel on the current connection and increments rejoinCount", async () => {
    // Contracts 9.2: three consecutive hub rejections while `socketState`
    // stays `connected` ask the socket loop to re-join once, via
    // socketLoop.rejoin(). Every re-invocation increments rejoinCount on the
    // transport telemetry.
    const state = createBeaconState();
    let hub!: CountingHub;
    const loop = startSocketLoop({
      build: () => (hub = new CountingHub()),
      ingestChannel: "x:ingest",
      key: "wbk_x",
      state,
      sleep: yieldMacrotask,
    });
    await drain();
    expect(state.socketState).toBe("connected");
    expect(hub.joinCount).toBe(1);
    expect(state.rejoinCount).toBe(0);

    await loop.rejoin();
    expect(hub.joinCount).toBe(2);
    expect(state.rejoinCount).toBe(1);
    expect(state.socketState).toBe("connected");

    await loop.stop();
    expect(state.socketState).toBe("disconnected");
  });

  it("rejoin() that throws takes the failure branch so the send loop falls back to HTTP", async () => {
    const state = createBeaconState();
    class ThrowingRejoinHub extends FakeHubClient {
      public joinCount = 0;
      override invoke<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
        if (method === "JoinPrivateChannel") {
          this.joinCount += 1;
          if (this.joinCount === 1) return Promise.resolve(undefined as unknown as T);
          return Promise.reject(new Error("evicted"));
        }
        return super.invoke<T>(method, ...args);
      }
    }
    let hub!: ThrowingRejoinHub;
    // Use a sleep that never resolves so the outer loop doesn't reconnect
    // before the test checks state.
    const neverSleep = () => new Promise<void>(() => {});
    const loop = startSocketLoop({
      build: () => (hub = new ThrowingRejoinHub()),
      ingestChannel: "x:ingest",
      key: "wbk_x",
      state,
      sleep: neverSleep,
    });
    // The outer loop's inner "sleep(1000)" is neverSleep, so as soon as
    // markConnected sets state to "connected" the loop parks. Give the
    // Promise.resolve().then(loop) chain a chance to reach that point.
    for (let i = 0; i < 10; i++) await yieldMacrotask();
    expect(state.socketState).toBe("connected");
    expect(hub.joinCount).toBe(1);
    // Trigger a rejoin that throws.
    await loop.rejoin();
    // rejoinCount incremented (every re-invocation counts).
    expect(state.rejoinCount).toBe(1);
    // The failure branch dropped the connection; state is "reconnecting" and
    // the send loop's `decide()` will now pick the HTTP door.
    expect(state.socketState).toBe("reconnecting");
    await loop.stop();
  });

  it("re-invokes JoinPrivateChannel on the freshly built connection after a reconnect", async () => {
    const state = createBeaconState();
    const built: CountingHub[] = [];
    const loop = startSocketLoop({
      build: () => {
        const h = new CountingHub();
        built.push(h);
        return h;
      },
      ingestChannel: "x:ingest",
      key: "wbk_x",
      state,
      sleep: yieldMacrotask,
    });
    await drain();
    expect(built).toHaveLength(1);
    expect(built[0]!.joinCount).toBe(1);

    built[0]!.triggerClose(new Error("1006"));
    await drain();

    expect(built.length).toBeGreaterThanOrEqual(2);
    const fresh = built[built.length - 1]!;
    expect(fresh.joinCount).toBe(1);
    expect(state.socketState).toBe("connected");
    await loop.stop();
  });

  it("ignores envelopes for channels this beacon did not join", async () => {
    const state = createBeaconState();
    let hub!: CountingHub;
    let connectedCount = 0;
    const loop = startSocketLoop({
      build: () => (hub = new CountingHub()),
      ingestChannel: "x:ingest",
      key: "wbk_x",
      state,
      onConnected: () => {
        connectedCount += 1;
      },
      sleep: yieldMacrotask,
    });
    await drain();
    expect(state.socketState).toBe("connected");
    expect(hub.joinCount).toBe(1);

    // A joined ack for someone else's channel: ignored.
    hub.emit("ChannelEvent", {
      channel: "y:ingest",
      event: "joined",
      data: { channel: "y:ingest" },
    });
    // An eviction for someone else's channel: also ignored (no re-invoke, no
    // reconnect).
    hub.emit("ChannelEvent", {
      channel: "y:ingest",
      event: "channelEvicted",
      data: { channel: "y:ingest", reason: "auth_expired" },
    });
    await drain();

    expect(hub.joinCount).toBe(1);
    expect(connectedCount).toBe(1);
    expect(state.socketState).toBe("connected");

    await loop.stop();
    expect(state.socketState).toBe("disconnected");
  });
});

describe("socket state transitions log at INFO", () => {
  interface LogLine {
    level: "info" | "warn";
    fields: Record<string, unknown>;
    msg: string;
  }
  function makeLog(): { lines: LogLine[]; log: { info: (f: Record<string, unknown>, m: string) => void; warn: (f: Record<string, unknown>, m: string) => void } } {
    const lines: LogLine[] = [];
    return {
      lines,
      log: {
        info: (fields, msg) => lines.push({ level: "info", fields, msg }),
        warn: (fields, msg) => lines.push({ level: "warn", fields, msg }),
      },
    };
  }

  async function waitConnected(state: ReturnType<typeof createBeaconState>): Promise<void> {
    for (let i = 0; i < 200; i++) {
      if (state.socketState === "connected") return;
      await yieldMacrotask();
    }
    throw new Error(`timed out waiting for 'connected'; state=${state.socketState}`);
  }

  it("logs a single INFO on connect with the channel and reconnectCount", async () => {
    const state = createBeaconState();
    const { lines, log } = makeLog();
    const loop = startSocketLoop({
      build: () => new FakeHubClient(),
      ingestChannel: "x:ingest",
      key: "wbk_secret_should_never_appear",
      state,
      sleep: yieldMacrotask,
      log,
    });
    await waitConnected(state);
    const connectLines = lines.filter((l) => l.msg === "socket connected");
    expect(connectLines).toHaveLength(1);
    expect(connectLines[0]!.level).toBe("info");
    expect(connectLines[0]!.fields.channel).toBe("x:ingest");
    expect(connectLines[0]!.fields.reconnectCount).toBe(1);
    await loop.stop();
  });

  it("logs a single INFO on transport-level close including err and scheduled delayMs", async () => {
    const state = createBeaconState();
    const { lines, log } = makeLog();
    const built: FakeHubClient[] = [];
    const loop = startSocketLoop({
      build: () => {
        const h = new FakeHubClient();
        built.push(h);
        return h;
      },
      ingestChannel: "x:ingest",
      key: "wbk_secret_should_never_appear",
      state,
      sleep: yieldMacrotask,
      log,
    });
    await waitConnected(state);
    lines.length = 0;
    built[0]!.triggerClose(new Error("WebSocket closed with status code: 1006"));
    await waitConnected(state);

    const closeLines = lines.filter((l) => l.msg === "socket closed; reconnecting");
    expect(closeLines.length).toBeGreaterThanOrEqual(1);
    const first = closeLines[0]!;
    expect(first.level).toBe("info");
    expect(first.fields.channel).toBe("x:ingest");
    expect(String(first.fields.err)).toMatch(/1006/);
    expect(first.fields.delayMs).toBe(1000);
    await loop.stop();
  });

  it("a reconnect logs 'socket connected' with an incremented reconnectCount so recovery is distinguishable from first connect", async () => {
    const state = createBeaconState();
    const { lines, log } = makeLog();
    const built: FakeHubClient[] = [];
    const loop = startSocketLoop({
      build: () => {
        const h = new FakeHubClient();
        built.push(h);
        return h;
      },
      ingestChannel: "x:ingest",
      key: "wbk_secret_should_never_appear",
      state,
      sleep: yieldMacrotask,
      log,
    });
    await waitConnected(state);
    built[0]!.triggerClose(new Error("1006"));
    await waitConnected(state);

    const connectLines = lines.filter((l) => l.msg === "socket connected");
    expect(connectLines).toHaveLength(2);
    expect(connectLines[0]!.fields.reconnectCount).toBe(1);
    expect(connectLines[1]!.fields.reconnectCount).toBe(2);
    await loop.stop();
  });

  it("never logs the beacon key or any credential material", async () => {
    const state = createBeaconState();
    const { lines, log } = makeLog();
    const secret = "wbk_TOP_SECRET_KEY_MUST_NOT_LEAK";
    const built: FakeHubClient[] = [];
    let buildCount = 0;
    const loop = startSocketLoop({
      build: () => {
        buildCount += 1;
        // First build is a denied join, so the denial code path fires; second
        // build succeeds so the loop reaches "connected" and we can drop it.
        const h = new FakeHubClient();
        if (buildCount === 1) {
          h.joinBehavior = "denied";
          h.joinError = new Error("join denied by gateway");
        }
        built.push(h);
        return h;
      },
      ingestChannel: "x:ingest",
      key: secret,
      state,
      sleep: yieldMacrotask,
      log,
    });
    await waitConnected(state);
    // Force a drop and reconnect.
    built[built.length - 1]!.triggerClose(new Error("1006"));
    await waitConnected(state);
    // Force an auth_expired eviction so tryRejoinOn fires.
    built[built.length - 1]!.emit("ChannelEvent", {
      channel: "x:ingest",
      event: "channelEvicted",
      data: { channel: "x:ingest", reason: "auth_expired" },
    });
    await drain();
    await loop.rejoin();
    await drain();

    for (const line of lines) {
      const serialized = JSON.stringify({ msg: line.msg, fields: line.fields });
      expect(serialized).not.toContain(secret);
    }
    await loop.stop();
  });

  it("a steady connected beacon emits no repeated socket lines", async () => {
    const state = createBeaconState();
    const { lines, log } = makeLog();
    const loop = startSocketLoop({
      build: () => new FakeHubClient(),
      ingestChannel: "x:ingest",
      key: "wbk_x",
      state,
      sleep: yieldMacrotask,
      log,
    });
    await waitConnected(state);
    const linesAfterConnect = [...lines];
    // Let the loop idle: many macrotask turns while nothing changes.
    for (let i = 0; i < 200; i++) await yieldMacrotask();
    expect(lines).toEqual(linesAfterConnect);
    await loop.stop();
  });

  it("a join denial logs the eviction/denial and carries the channel", async () => {
    const state = createBeaconState();
    const { lines, log } = makeLog();
    let hub!: FakeHubClient;
    const loop = startSocketLoop({
      build: () => (hub = new FakeHubClient()),
      ingestChannel: "x:ingest",
      key: "wbk_x",
      state,
      sleep: yieldMacrotask,
      log,
    });
    await waitConnected(state);
    hub.emit("ChannelEvent", {
      channel: "x:ingest",
      event: "channelEvicted",
      data: { channel: "x:ingest", reason: "service_removed" },
    });
    await drain();
    const evictLines = lines.filter((l) => l.msg === "socket evicted");
    expect(evictLines.length).toBeGreaterThanOrEqual(1);
    expect(evictLines[0]!.fields.channel).toBe("x:ingest");
    expect(evictLines[0]!.fields.reason).toBe("service_removed");
    await loop.stop();
  });
});

describe("transport-level close: reconnect is unbounded and covers every close reason", () => {
  // The scenario from the field: a gateway ASG instance refresh terminates the
  // hub node, the beacon's WebSocket closes with 1006, and the beacon must
  // rebuild and reconnect through the normal backoff branch. This is true for
  // every close reason (error or clean), for as many closes as arrive, forever.

  class CountingHub extends FakeHubClient {
    public joinCount = 0;
    override invoke<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
      if (method === "JoinPrivateChannel") {
        this.joinCount += 1;
        return Promise.resolve(undefined as unknown as T);
      }
      return super.invoke<T>(method, ...args);
    }
  }

  async function waitConnected(state: ReturnType<typeof createBeaconState>): Promise<void> {
    for (let i = 0; i < 200; i++) {
      if (state.socketState === "connected") return;
      await yieldMacrotask();
    }
    throw new Error(`timed out waiting for 'connected'; state=${state.socketState}`);
  }

  it("regression: a transport-level close must never leave the loop spinning on a dead client", async () => {
    // Direct reproduction of the production symptom: WebSocket closes with
    // status code 1006 (no reason given). With the loop's old inner
    // `while (!stopped && current === client) sleep(1000)` gate and an onClose
    // handler that only mutated `state.socketState`, `current` still pointed at
    // the dead client after the close and the loop spun forever. The fix must
    // release the dead client so the outer reconnect branch runs.
    const state = createBeaconState();
    const built: FakeHubClient[] = [];
    const loop = startSocketLoop({
      build: () => {
        const h = new FakeHubClient();
        built.push(h);
        return h;
      },
      ingestChannel: "x:ingest",
      key: "wbk_x",
      state,
      sleep: yieldMacrotask,
    });
    await waitConnected(state);
    expect(built).toHaveLength(1);

    const dead = built[0]!;
    dead.triggerClose(new Error("WebSocket closed with status code: 1006 (no reason given)."));
    await waitConnected(state);

    expect(built.length).toBeGreaterThan(1);
    expect(built[built.length - 1]).not.toBe(dead);
    await loop.stop();
  });

  it("onClose with an Error cause rebuilds the client and reconnects", async () => {
    const state = createBeaconState();
    const built: FakeHubClient[] = [];
    const loop = startSocketLoop({
      build: () => {
        const h = new FakeHubClient();
        built.push(h);
        return h;
      },
      ingestChannel: "x:ingest",
      key: "wbk_x",
      state,
      sleep: yieldMacrotask,
    });
    await waitConnected(state);

    built[0]!.triggerClose(new Error("Connection disconnected with error 'WebSocket closed with status code: 1006 (no reason given).'"));
    await waitConnected(state);

    expect(built.length).toBe(2);
    expect(state.socketState).toBe("connected");
    await loop.stop();
  });

  it("onClose with a clean (undefined) cause rebuilds the client and reconnects", async () => {
    const state = createBeaconState();
    const built: FakeHubClient[] = [];
    const loop = startSocketLoop({
      build: () => {
        const h = new FakeHubClient();
        built.push(h);
        return h;
      },
      ingestChannel: "x:ingest",
      key: "wbk_x",
      state,
      sleep: yieldMacrotask,
    });
    await waitConnected(state);

    built[0]!.triggerClose();
    await waitConnected(state);

    expect(built.length).toBe(2);
    expect(state.socketState).toBe("connected");
    await loop.stop();
  });

  it("25 consecutive transport-level closes produce 25 reconnects (no attempt cap, no give-up)", async () => {
    const state = createBeaconState();
    const built: FakeHubClient[] = [];
    const loop = startSocketLoop({
      build: () => {
        const h = new FakeHubClient();
        built.push(h);
        return h;
      },
      ingestChannel: "x:ingest",
      key: "wbk_x",
      state,
      sleep: yieldMacrotask,
    });
    await waitConnected(state);
    expect(state.reconnectCount).toBe(1);
    expect(built.length).toBe(1);

    for (let i = 0; i < 25; i++) {
      built[built.length - 1]!.triggerClose(new Error("1006"));
      await waitConnected(state);
    }

    expect(state.reconnectCount).toBe(26);
    expect(built.length).toBe(26);
    await loop.stop();
  });

  it("socketState goes connected -> reconnecting -> connected across a drop; reconnectCount +=1 per reconnect", async () => {
    const state = createBeaconState();
    const built: FakeHubClient[] = [];
    const disconnects: number[] = [];
    const loop = startSocketLoop({
      build: () => {
        const h = new FakeHubClient();
        built.push(h);
        return h;
      },
      ingestChannel: "x:ingest",
      key: "wbk_x",
      state,
      onDisconnected: () => disconnects.push(1),
      sleep: yieldMacrotask,
    });
    await waitConnected(state);
    expect(state.socketState).toBe("connected");
    expect(state.reconnectCount).toBe(1);

    built[0]!.triggerClose(new Error("1006"));
    expect(state.socketState).toBe("reconnecting");

    await waitConnected(state);
    expect(state.reconnectCount).toBe(2);
    expect(disconnects.length).toBeGreaterThanOrEqual(1);

    await loop.stop();
  });

  it("backoff follows 1s, 2s, 3s, 5s then stays 5s across many further reconnect attempts", async () => {
    // Force every attempt to fail so `attempt` climbs monotonically instead of
    // being reset by a successful connect, then read back the sleep sequence
    // the loop asked for.
    const state = createBeaconState();
    const sleeps: number[] = [];
    let loopHandle!: { stop(): Promise<void> };
    loopHandle = startSocketLoop({
      build: () => {
        const h = new FakeHubClient();
        h.startBehavior = "throw";
        h.startError = new Error("connect failed");
        return h;
      },
      ingestChannel: "x:ingest",
      key: "wbk_x",
      state,
      sleep: async (ms) => {
        sleeps.push(ms);
        if (sleeps.length >= 10) await loopHandle.stop();
      },
    });
    await drain();
    await drain();
    expect(sleeps.slice(0, 10)).toEqual([
      1000, 2000, 3000, 5000, 5000, 5000, 5000, 5000, 5000, 5000,
    ]);
  });

  it("stop() terminates the loop promptly; no reconnect happens after stop()", async () => {
    const state = createBeaconState();
    const built: FakeHubClient[] = [];
    const loop = startSocketLoop({
      build: () => {
        const h = new FakeHubClient();
        built.push(h);
        return h;
      },
      ingestChannel: "x:ingest",
      key: "wbk_x",
      state,
      sleep: yieldMacrotask,
    });
    await waitConnected(state);
    const buildsAtStop = built.length;

    await loop.stop();
    expect(state.socketState).toBe("disconnected");

    // Late-arriving close events must not spawn a new client.
    for (const h of built) h.triggerClose(new Error("late close"));
    await drain();
    await drain();
    expect(built.length).toBe(buildsAtStop);
    expect(state.socketState).toBe("disconnected");
  });

  it("a transport-level close arriving while a rejoin is in flight still reconnects", async () => {
    // Contracts 9.2 audit: `channelEvicted auth_expired` fires an in-flight
    // rejoin invoke; if the transport then dies underneath it, the loop must
    // still drop the dead client and rebuild.
    const state = createBeaconState();
    let pendingRejoin: ((v?: unknown) => void) | null = null;
    class HangingRejoinHub extends FakeHubClient {
      public joinCount = 0;
      override invoke<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
        if (method === "JoinPrivateChannel") {
          this.joinCount += 1;
          if (this.joinCount === 1) return Promise.resolve(undefined as unknown as T);
          return new Promise<T>((_res, rej) => {
            pendingRejoin = () => rej(new Error("connection lost"));
          });
        }
        return super.invoke<T>(method, ...args);
      }
    }
    const built: HangingRejoinHub[] = [];
    const loop = startSocketLoop({
      build: () => {
        const h = new HangingRejoinHub();
        built.push(h);
        return h;
      },
      ingestChannel: "x:ingest",
      key: "wbk_x",
      state,
      sleep: yieldMacrotask,
    });
    for (let i = 0; i < 200; i++) {
      if (state.socketState === "connected") break;
      await yieldMacrotask();
    }
    expect(state.socketState).toBe("connected");
    expect(built[0]!.joinCount).toBe(1);

    built[0]!.emit("ChannelEvent", {
      channel: "x:ingest",
      event: "channelEvicted",
      data: { channel: "x:ingest", reason: "auth_expired" },
    });
    await drain();
    expect(built[0]!.joinCount).toBe(2);
    expect(state.rejoinCount).toBe(1);

    built[0]!.triggerClose(new Error("1006"));
    if (pendingRejoin) (pendingRejoin as () => void)();
    for (let i = 0; i < 200; i++) {
      if (state.socketState === "connected" && built.length >= 2) break;
      await yieldMacrotask();
    }
    expect(built.length).toBeGreaterThanOrEqual(2);
    expect(state.socketState).toBe("connected");
    await loop.stop();
  });
});

describe("connect handshake races the close signal", () => {
  // The connect handshake and the connected spin loop each race against a
  // per-iteration close signal fed from onClose. A transport-level close that
  // arrives while start() or invoke() is still pending must abort the handshake
  // and fall through to the normal reconnect branch immediately, not after the
  // pending call's own timeout. The same signal breaks the connected spin
  // loop's sleep so the loop exits the instant a close arrives.

  async function waitConnected(state: ReturnType<typeof createBeaconState>): Promise<void> {
    for (let i = 0; i < 200; i++) {
      if (state.socketState === "connected") return;
      await yieldMacrotask();
    }
    throw new Error(`timed out waiting for 'connected'; state=${state.socketState}`);
  }

  it("a close arriving while start() is still pending aborts the handshake and reconnects (no timeout wait)", async () => {
    // The first hub hangs in start(); a close is fired while it's pending. The
    // loop must abort start() via the close signal and rebuild.
    class HangingStartHub extends FakeHubClient {
      override async start(): Promise<void> {
        this.started = true;
        // Never resolve on its own; only the close signal will end the wait.
        await new Promise<void>(() => {});
      }
    }
    const state = createBeaconState();
    const built: FakeHubClient[] = [];
    let buildCount = 0;
    const loop = startSocketLoop({
      build: () => {
        buildCount += 1;
        const h = buildCount === 1 ? new HangingStartHub() : new FakeHubClient();
        built.push(h);
        return h;
      },
      ingestChannel: "x:ingest",
      key: "wbk_x",
      state,
      sleep: yieldMacrotask,
    });
    // Wait for the hanging first client to be built and its onClose registered.
    for (let i = 0; i < 200; i++) {
      if (built.length >= 1 && built[0]!.closeHandlers.length > 0) break;
      await yieldMacrotask();
    }
    expect(built.length).toBe(1);
    // Confirm start is stuck: state stays "connecting", not "connected".
    expect(state.socketState).toBe("connecting");

    built[0]!.triggerClose(new Error("1006"));
    await waitConnected(state);

    expect(built.length).toBeGreaterThanOrEqual(2);
    expect(state.socketState).toBe("connected");
    await loop.stop();
  });

  it("a close arriving while the JoinPrivateChannel invoke is still pending aborts and reconnects (no timeout wait)", async () => {
    // The first hub hangs in JoinPrivateChannel; a close is fired while the
    // invoke is pending. The close-signal race makes the loop reconnect
    // without waiting for the invoke to settle.
    let hangingResolve: (() => void) | null = null;
    class HangingJoinHub extends FakeHubClient {
      override invoke<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
        if (method === "JoinPrivateChannel") {
          return new Promise<T>((resolve) => {
            hangingResolve = () => resolve(undefined as unknown as T);
          });
        }
        return super.invoke<T>(method, ...args);
      }
    }
    const state = createBeaconState();
    const built: FakeHubClient[] = [];
    let buildCount = 0;
    const loop = startSocketLoop({
      build: () => {
        buildCount += 1;
        const h = buildCount === 1 ? new HangingJoinHub() : new FakeHubClient();
        built.push(h);
        return h;
      },
      ingestChannel: "x:ingest",
      key: "wbk_x",
      state,
      sleep: yieldMacrotask,
    });
    // Wait for the first hub's onClose handler to be attached (start() has
    // resolved and we're now awaiting the pending invoke).
    for (let i = 0; i < 200; i++) {
      if (built.length >= 1 && built[0]!.closeHandlers.length > 0) break;
      await yieldMacrotask();
    }
    expect(built.length).toBe(1);
    expect(state.socketState).toBe("connecting");
    // Give the loop a chance to reach the pending-invoke point.
    for (let i = 0; i < 20; i++) await yieldMacrotask();

    built[0]!.triggerClose(new Error("1006"));
    await waitConnected(state);

    // Never resolved the hanging invoke; the close-signal race did the work.
    expect(hangingResolve).not.toBeNull();
    expect(built.length).toBeGreaterThanOrEqual(2);
    expect(state.socketState).toBe("connected");
    await loop.stop();
  });

  it("a close that arrives after start and invoke have already resolved still reconnects and produces no unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const state = createBeaconState();
      const built: FakeHubClient[] = [];
      const loop = startSocketLoop({
        build: () => {
          const h = new FakeHubClient();
          built.push(h);
          return h;
        },
        ingestChannel: "x:ingest",
        key: "wbk_x",
        state,
        sleep: yieldMacrotask,
      });
      await waitConnected(state);
      expect(built.length).toBe(1);

      // start() and invoke() have long since resolved. Trigger a close and
      // give the microtask queue several turns for any unhandled rejection to
      // surface.
      built[0]!.triggerClose(new Error("1006"));
      await waitConnected(state);
      for (let i = 0; i < 50; i++) await yieldMacrotask();

      expect(built.length).toBeGreaterThanOrEqual(2);
      expect(state.socketState).toBe("connected");
      expect(unhandled).toEqual([]);
      await loop.stop();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("the connected spin loop exits immediately on close rather than after the poll interval", async () => {
    // The connected spin loop's sleep is raced against the close signal. A
    // sleep that never resolves while state is "connected" proves the loop is
    // not gated on the poll interval: the close signal alone must end the
    // wait. The reconnect-branch sleep (state "reconnecting") is still allowed
    // so the outer loop can rebuild.
    const state = createBeaconState();
    const built: FakeHubClient[] = [];
    const sleep = (_ms: number): Promise<void> => {
      if (state.socketState === "connected") {
        return new Promise<void>(() => {});
      }
      return new Promise<void>((r) => setImmediate(r));
    };
    const loop = startSocketLoop({
      build: () => {
        const h = new FakeHubClient();
        built.push(h);
        return h;
      },
      ingestChannel: "x:ingest",
      key: "wbk_x",
      state,
      sleep,
    });
    await waitConnected(state);
    expect(built.length).toBe(1);

    built[0]!.triggerClose(new Error("1006"));
    await waitConnected(state);

    expect(built.length).toBeGreaterThanOrEqual(2);
    expect(state.socketState).toBe("connected");
    await loop.stop();
  });
});
