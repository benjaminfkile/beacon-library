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

  it("regression: a transport-level close must not leave the loop spinning on a dead client", async () => {
    // The exact production symptom (2026-09-16): the ws socket closed with
    // 1006, `state.socketState` moved to `reconnecting`, and the loop never
    // rebuilt because nothing broke the inner keep-alive. onClose must release
    // the dead client so the outer reconnect path runs.
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
    await drain();
    expect(state.socketState).toBe("connected");
    expect(built.length).toBe(1);
    expect(state.reconnectCount).toBe(1);

    // A transport-level close with the 1006-style error. The loop MUST rebuild
    // and reconnect. If this test hangs, the loop wedged on the dead client.
    built[0]!.triggerClose(new Error("WebSocket closed with status code: 1006 (no reason given)."));
    await drain();

    expect(built.length).toBeGreaterThanOrEqual(2);
    expect(state.socketState).toBe("connected");
    expect(state.reconnectCount).toBe(2);

    await loop.stop();
    expect(state.socketState).toBe("disconnected");
  });

  it("reconnects when onClose fires with an Error cause", async () => {
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
    await drain();
    expect(state.socketState).toBe("connected");
    built[0]!.triggerClose(new Error("boom"));
    await drain();
    expect(built.length).toBeGreaterThanOrEqual(2);
    expect(state.socketState).toBe("connected");
    await loop.stop();
  });

  it("reconnects when onClose fires with an undefined (clean) cause", async () => {
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
    await drain();
    expect(state.socketState).toBe("connected");
    built[0]!.triggerClose(undefined);
    await drain();
    expect(built.length).toBeGreaterThanOrEqual(2);
    expect(state.socketState).toBe("connected");
    await loop.stop();
  });

  it("25 consecutive closes yield 25 reconnects (unbounded, no give-up branch)", async () => {
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
    await drain();
    expect(state.socketState).toBe("connected");
    expect(state.reconnectCount).toBe(1);

    for (let i = 0; i < 25; i++) {
      // Close the current live client; the loop must rebuild every time.
      const live = built[built.length - 1]!;
      live.triggerClose(new Error(`close ${i + 1}`));
      // Wait until a new client has been built AND has reached connected.
      for (let j = 0; j < 200 && (built.length <= i + 1 || state.socketState !== "connected"); j++) {
        await yieldMacrotask();
      }
      expect(built.length).toBe(i + 2);
      expect(state.socketState).toBe("connected");
    }

    // 1 initial + 25 reconnects = 26.
    expect(state.reconnectCount).toBe(26);
    expect(built.length).toBe(26);

    await loop.stop();
  });

  it("backoff sequence is 1s, 2s, 3s, 5s, then 5s across many further attempts", async () => {
    // Force consecutive failed connect attempts by having build() throw a lot,
    // then stop the loop before the inner keep-alive can spin. The recorded
    // sleeps must be 1000, 2000, 3000, 5000, then 5000 forever.
    const state = createBeaconState();
    const sleepCalls: number[] = [];
    let buildCalls = 0;
    const totalFailures = 12;
    let loopHandle!: { stop(): Promise<void> };
    loopHandle = startSocketLoop({
      build: () => {
        buildCalls += 1;
        throw new Error(`build fail ${buildCalls}`);
      },
      ingestChannel: "x:ingest",
      key: "wbk_x",
      state,
      sleep: async (ms) => {
        sleepCalls.push(ms);
        if (sleepCalls.length >= totalFailures) await loopHandle.stop();
      },
    });
    for (let i = 0; i < 200 && sleepCalls.length < totalFailures; i++) {
      await yieldMacrotask();
    }
    expect(sleepCalls.length).toBeGreaterThanOrEqual(totalFailures);
    // The first 4 backoff waits are 1s, 2s, 3s, 5s.
    expect(sleepCalls.slice(0, 4)).toEqual([1000, 2000, 3000, 5000]);
    // All subsequent waits are 5s (5s forever).
    for (let i = 4; i < totalFailures; i++) {
      expect(sleepCalls[i]).toBe(5000);
    }
  });

  it("socketState traces connected -> reconnecting -> connected across a drop, and reconnectCount increments once per reconnect", async () => {
    const state = createBeaconState();
    const built: FakeHubClient[] = [];
    let disconnects = 0;
    const loop = startSocketLoop({
      build: () => {
        const h = new FakeHubClient();
        built.push(h);
        return h;
      },
      ingestChannel: "x:ingest",
      key: "wbk_x",
      state,
      onDisconnected: () => {
        disconnects += 1;
      },
      sleep: yieldMacrotask,
    });
    await drain();
    expect(state.socketState).toBe("connected");
    expect(state.reconnectCount).toBe(1);
    expect(disconnects).toBe(0);

    built[0]!.triggerClose(new Error("drop"));
    // Right after triggerClose the onClose handler must have moved the state
    // off "connected". Sample synchronously.
    expect(state.socketState).toBe("reconnecting");

    for (let i = 0; i < 200 && state.reconnectCount < 2; i++) {
      await yieldMacrotask();
    }
    expect(state.socketState).toBe("connected");
    expect(state.reconnectCount).toBe(2);
    expect(disconnects).toBeGreaterThanOrEqual(1);

    await loop.stop();
  });

  it("re-invokes JoinPrivateChannel on the ingest channel after every reconnect", async () => {
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
    expect(state.socketState).toBe("connected");
    expect(built[0]!.joinCount).toBe(1);

    for (let i = 0; i < 5; i++) {
      built[built.length - 1]!.triggerClose(new Error("bounce"));
      for (let j = 0; j < 200 && (built.length <= i + 1 || state.socketState !== "connected"); j++) {
        await yieldMacrotask();
      }
      expect(built[built.length - 1]!.joinCount).toBe(1);
      expect(state.socketState).toBe("connected");
    }

    // Every rebuild joined its ingest channel exactly once on connect.
    expect(built.length).toBe(6);
    for (const h of built) expect(h.joinCount).toBe(1);

    await loop.stop();
  });

  it("stop() terminates the loop promptly and no reconnect happens afterwards", async () => {
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
    await drain();
    expect(state.socketState).toBe("connected");
    expect(built.length).toBe(1);

    await loop.stop();
    expect(state.socketState).toBe("disconnected");
    const buildsAtStop = built.length;

    // A close that lands after stop must not rebuild.
    built[0]!.triggerClose(new Error("post-stop"));
    await drain();
    await drain();
    expect(built.length).toBe(buildsAtStop);
    expect(state.socketState).toBe("disconnected");
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

describe("socket loop INFO transition logs", () => {
  interface LogLine {
    level: "info" | "warn";
    obj: Record<string, unknown>;
    msg: string;
  }
  function makeLog(): { lines: LogLine[]; log: { info: (obj: Record<string, unknown>, msg: string) => void; warn: (obj: Record<string, unknown>, msg: string) => void } } {
    const lines: LogLine[] = [];
    return {
      lines,
      log: {
        info: (obj, msg) => lines.push({ level: "info", obj, msg }),
        warn: (obj, msg) => lines.push({ level: "warn", obj, msg }),
      },
    };
  }

  it("a first connect logs one INFO line with channel and reconnectCount=1", async () => {
    const state = createBeaconState();
    const { lines, log } = makeLog();
    const loop = startSocketLoop({
      build: () => new FakeHubClient(),
      ingestChannel: "x:ingest",
      key: "wbk_secret_do_not_log",
      state,
      sleep: yieldMacrotask,
      log,
    });
    await drain();
    expect(state.socketState).toBe("connected");
    const connectLines = lines.filter((l) => l.msg === "socket connected");
    expect(connectLines.length).toBe(1);
    expect(connectLines[0]!.level).toBe("info");
    expect(connectLines[0]!.obj.channel).toBe("x:ingest");
    expect(connectLines[0]!.obj.reconnectCount).toBe(1);
    expect(connectLines[0]!.obj.attempt).toBe(0);
    await loop.stop();
  });

  it("a drop logs one INFO line with the close reason and the scheduled delay", async () => {
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
      key: "wbk_secret_do_not_log",
      state,
      sleep: yieldMacrotask,
      log,
    });
    await drain();
    expect(state.socketState).toBe("connected");

    built[0]!.triggerClose(new Error("WebSocket closed with status code: 1006 (no reason given)."));
    await drain();

    const closeLines = lines.filter((l) => l.msg === "socket closed; reconnecting");
    expect(closeLines.length).toBeGreaterThanOrEqual(1);
    const first = closeLines[0]!;
    expect(first.level).toBe("info");
    expect(first.obj.channel).toBe("x:ingest");
    expect(String(first.obj.err)).toMatch(/1006/);
    expect(first.obj.delayMs).toBe(1000);
    expect(first.obj.attempt).toBe(0); // the attempt that just ended, counted from 0 as Red-Nose logs it
    await loop.stop();
  });

  it("a reconnect logs at INFO with an incremented reconnectCount so recovery differs from first connect", async () => {
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
      key: "wbk_secret_do_not_log",
      state,
      sleep: yieldMacrotask,
      log,
    });
    await drain();
    expect(state.socketState).toBe("connected");

    built[0]!.triggerClose(new Error("drop"));
    for (let j = 0; j < 200 && state.reconnectCount < 2; j++) {
      await yieldMacrotask();
    }
    expect(state.socketState).toBe("connected");
    expect(state.reconnectCount).toBe(2);

    const connectLines = lines.filter((l) => l.msg === "socket connected");
    expect(connectLines.length).toBe(2);
    expect(connectLines[0]!.obj.reconnectCount).toBe(1);
    expect(connectLines[1]!.obj.reconnectCount).toBe(2);
    await loop.stop();
  });

  it("never logs the beacon key, token, or credential value", async () => {
    const state = createBeaconState();
    const { lines, log } = makeLog();
    const secret = "wbk_super_secret_KEY_value_123";
    const built: FakeHubClient[] = [];
    class DenyingHub extends FakeHubClient {
      constructor() {
        super();
        this.joinBehavior = "denied";
        this.joinError = new Error("join denied by gateway");
      }
    }
    let count = 0;
    const loopHandle: { stop: () => Promise<void> } = { stop: async () => {} };
    const loop = startSocketLoop({
      build: () => {
        count += 1;
        const h = count === 1 ? new DenyingHub() : new FakeHubClient();
        built.push(h);
        return h;
      },
      ingestChannel: "x:ingest",
      key: secret,
      state,
      sleep: async (_ms) => {
        // Kick us through the denied wait and then the successful connect.
        if (count >= 2) await loopHandle.stop();
      },
      log,
    });
    loopHandle.stop = () => loop.stop();
    for (let i = 0; i < 200 && count < 2; i++) await yieldMacrotask();
    // Trigger an eviction on the connected client, then a rejoin failure via a
    // hub that rejects the second invoke.
    for (const line of lines) {
      const dump = JSON.stringify(line);
      expect(dump).not.toContain(secret);
      expect(dump).not.toMatch(/wbk_/);
      expect(dump).not.toMatch(/token/i);
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
    await drain();
    expect(state.socketState).toBe("connected");
    const linesAfterConnect = lines.length;
    // Let the inner keep-alive loop iterate several times without any drop.
    for (let i = 0; i < 20; i++) await yieldMacrotask();
    expect(lines.length).toBe(linesAfterConnect);
    // And the single line we did emit was the connect line.
    expect(lines.filter((l) => l.msg === "socket connected").length).toBe(1);
    await loop.stop();
  });

  it("an eviction logs at INFO and carries the channel", async () => {
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
    await drain();
    expect(state.socketState).toBe("connected");
    hub.emit("ChannelEvent", {
      channel: "x:ingest",
      event: "channelEvicted",
      data: { channel: "x:ingest", reason: "auth_expired" },
    });
    await drain();
    const evict = lines.filter((l) => l.msg === "socket evicted");
    expect(evict.length).toBeGreaterThanOrEqual(1);
    expect(evict[0]!.level).toBe("info");
    expect(evict[0]!.obj.channel).toBe("x:ingest");
    expect(evict[0]!.obj.reason).toBe("auth_expired");
    await loop.stop();
  });

  it("a rejoin logs at INFO with the channel", async () => {
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
    await drain();
    expect(state.socketState).toBe("connected");
    await loop.rejoin();
    const rejoinLines = lines.filter((l) => l.msg === "socket rejoined");
    expect(rejoinLines.length).toBe(1);
    expect(rejoinLines[0]!.level).toBe("info");
    expect(rejoinLines[0]!.obj.channel).toBe("x:ingest");
    await loop.stop();
  });

  it("a rejoin failure logs at WARN with the channel and err", async () => {
    const state = createBeaconState();
    const { lines, log } = makeLog();
    class ThrowRejoin extends FakeHubClient {
      public joinCount = 0;
      override invoke<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
        if (method === "JoinPrivateChannel") {
          this.joinCount += 1;
          if (this.joinCount === 1) return Promise.resolve(undefined as unknown as T);
          return Promise.reject(new Error("nope"));
        }
        return super.invoke<T>(method, ...args);
      }
    }
    const neverSleep = () => new Promise<void>(() => {});
    let hub!: ThrowRejoin;
    const loop = startSocketLoop({
      build: () => (hub = new ThrowRejoin()),
      ingestChannel: "x:ingest",
      key: "wbk_x",
      state,
      sleep: neverSleep,
      log,
    });
    for (let i = 0; i < 10; i++) await yieldMacrotask();
    expect(state.socketState).toBe("connected");
    await loop.rejoin();
    const fail = lines.filter((l) => l.msg === "socket rejoin failed");
    expect(fail.length).toBe(1);
    expect(fail[0]!.level).toBe("warn");
    expect(fail[0]!.obj.channel).toBe("x:ingest");
    expect(String(fail[0]!.obj.err)).toMatch(/nope/);
    await loop.stop();
  });
});
