// The send loop's decision table (contracts 9.2). Every scenario the brief
// enumerates is one row here.

import { describe, expect, it } from "vitest";
import { createBeaconState, setLatestFix } from "../src/state.js";
import { decide, startSendLoop } from "../src/sendLoop.js";
import { FakeHubClient, createFakeRest } from "./fakes.js";

const FIX = {
  lat: 46.87,
  lng: -114,
  recordedAt: "2026-12-22T01:31:07.000Z",
  speedMps: 1,
  altitudeM: 100,
  headingDeg: 0,
  accuracyM: 10,
};

describe("send loop decision", () => {
  it("skips when there is no fix", () => {
    const s = createBeaconState();
    expect(decide(s, false)).toEqual({ action: "skip", reason: "no-fix" });
  });

  it("skips when the current fix has already been delivered", () => {
    const s = createBeaconState();
    const f = setLatestFix(s, FIX);
    s.lastDeliveredSeqLocal = f.seqLocal;
    expect(decide(s, false)).toEqual({ action: "skip", reason: "already-delivered" });
  });

  it("skips when a send is in flight (one in-flight only)", () => {
    const s = createBeaconState();
    setLatestFix(s, FIX);
    expect(decide(s, true)).toEqual({ action: "skip", reason: "in-flight" });
  });

  it("uses the hub while socketState=connected (no fallback while the socket is up)", () => {
    const s = createBeaconState();
    setLatestFix(s, FIX);
    s.socketState = "connected";
    expect(decide(s, false)).toEqual({ action: "hub" });
  });

  it("uses HTTP while the socket is not connected", () => {
    const s = createBeaconState();
    setLatestFix(s, FIX);
    s.socketState = "reconnecting";
    expect(decide(s, false)).toEqual({ action: "http" });
  });
});

describe("send loop behaviour", () => {
  it("sends over the hub and records the receipt latency on success", async () => {
    const s = createBeaconState();
    setLatestFix(s, FIX);
    s.socketState = "connected";
    const rest = createFakeRest();
    const hub = new FakeHubClient();
    const loop = startSendLoop({
      state: s,
      rest,
      getHub: () => hub,
      ingestChannel: "wmsfo-api-dev:ingest",
      intervalMs: 1000,
    });
    // Fire manually; kick off tick, then resolve the recorded invoke.
    const p = loop.tick();
    // Yield so the invoke gets recorded.
    await Promise.resolve();
    await Promise.resolve();
    const inv = hub.lastInvoke();
    expect(inv).toBeDefined();
    expect(inv!.method).toBe("SendToChannel");
    expect(inv!.args[0]).toBe("wmsfo-api-dev:ingest");
    expect(inv!.args[1]).toBe("location");
    inv!.resolve();
    await p;
    expect(s.lastDeliveredSeqLocal).toBe(1);
    expect(s.lastReceiptLatencyMs).not.toBeNull();
    expect(s.sendsFailedSinceBoot).toBe(0);
    loop.stop();
  });

  it("does NOT fall back to HTTP while the socket is up on a rejected invoke", async () => {
    const s = createBeaconState();
    setLatestFix(s, FIX);
    s.socketState = "connected";
    s.lastHeartbeat = { receivedAt: "", liveEventId: 7, isActive: true };
    const rest = createFakeRest();
    const hub = new FakeHubClient();
    const loop = startSendLoop({
      state: s,
      rest,
      getHub: () => hub,
      ingestChannel: "wmsfo-api-dev:ingest",
      intervalMs: 60_000,
    });
    const p = loop.tick();
    await Promise.resolve();
    await Promise.resolve();
    hub.lastInvoke()!.reject(new Error("boom"));
    await p;
    expect(rest.locationCalls).toHaveLength(0);
    expect(s.sendsFailedSinceBoot).toBe(1);
    loop.stop();
  });

  it("uses HTTP fallback when the socket is not connected", async () => {
    const s = createBeaconState();
    setLatestFix(s, FIX);
    s.socketState = "reconnecting";
    const rest = createFakeRest();
    rest.nextLocation({
      ok: true,
      status: 201,
      seq: 1,
      published: true,
      receivedAt: "2026-12-22T01:31:07.100Z",
      serverTime: "2026-12-22T01:31:07.100Z",
    });
    const loop = startSendLoop({
      state: s,
      rest,
      getHub: () => null,
      ingestChannel: "wmsfo-api-dev:ingest",
      intervalMs: 60_000,
    });
    await loop.tick();
    expect(rest.locationCalls).toHaveLength(1);
    expect(s.lastDeliveredSeqLocal).toBe(1);
    loop.stop();
  });

  it("does NOT count sendsFailedSinceBoot before a live event is known", async () => {
    const s = createBeaconState();
    setLatestFix(s, FIX);
    s.socketState = "reconnecting";
    // No lastHeartbeat yet: the beacon hasn't learned liveEventId.
    const rest = createFakeRest();
    rest.nextLocation({
      ok: false,
      status: 409,
      code: "no_live_event",
      message: "",
      requestId: null,
      serverTime: null,
    });
    const loop = startSendLoop({
      state: s,
      rest,
      getHub: () => null,
      ingestChannel: "x:ingest",
      intervalMs: 60_000,
    });
    await loop.tick();
    expect(s.sendsFailedSinceBoot).toBe(0);
    loop.stop();
  });

  it("counts sendsFailedSinceBoot only when lastHeartbeat.liveEventId is non-null", async () => {
    const s = createBeaconState();
    setLatestFix(s, FIX);
    s.socketState = "reconnecting";
    s.lastHeartbeat = { receivedAt: "", liveEventId: 7, isActive: true };
    const rest = createFakeRest();
    rest.nextLocation({
      ok: false,
      status: 500,
      code: null,
      message: null,
      requestId: null,
      serverTime: null,
    });
    const loop = startSendLoop({
      state: s,
      rest,
      getHub: () => null,
      ingestChannel: "x:ingest",
      intervalMs: 60_000,
    });
    await loop.tick();
    expect(s.sendsFailedSinceBoot).toBe(1);
    loop.stop();
  });

  it("HTTP window: three fixes in one second produce one POST carrying the newest", async () => {
    // Contracts 9.2: over HTTP a send starts no sooner than
    // HTTP_FALLBACK_INTERVAL_MS after the previous HTTP send started; a fix
    // arriving inside the window replaces latestFix and the newest goes out
    // when the window ends.
    const s = createBeaconState();
    s.socketState = "reconnecting";
    s.lastHeartbeat = { receivedAt: "", liveEventId: 7, isActive: true };
    const rest = createFakeRest();
    for (let i = 0; i < 3; i++) {
      rest.nextLocation({
        ok: true,
        status: 201,
        seq: i + 1,
        published: true,
        receivedAt: "2026-12-22T01:31:07.100Z",
        serverTime: "2026-12-22T01:31:07.100Z",
      });
    }
    let clock = 10_000;
    const now = () => clock;
    const loop = startSendLoop({
      state: s,
      rest,
      getHub: () => null,
      ingestChannel: "x:ingest",
      intervalMs: 60_000,
      httpFallbackIntervalMs: 1000,
      now,
    });
    // First fix arrives; the loop sends it.
    setLatestFix(s, { ...FIX });
    await loop.tick();
    expect(rest.locationCalls).toHaveLength(1);
    expect(rest.locationCalls[0]!.body.lat).toBe(FIX.lat);
    // Two more fixes arrive inside the 1 s window; each `tick()` inside the
    // window schedules for the remainder rather than posting.
    clock = 10_200;
    setLatestFix(s, { ...FIX, lat: 47.0 });
    await loop.tick();
    expect(rest.locationCalls).toHaveLength(1);
    clock = 10_500;
    setLatestFix(s, { ...FIX, lat: 48.0 });
    await loop.tick();
    expect(rest.locationCalls).toHaveLength(1);
    // Advance past the window; the newest fix goes out.
    clock = 11_050;
    await loop.tick();
    expect(rest.locationCalls).toHaveLength(2);
    expect(rest.locationCalls[1]!.body.lat).toBe(48.0);
    loop.stop();
  });

  it("HTTP window: a socket that connects during the window takes the fix (no HTTP)", async () => {
    const s = createBeaconState();
    s.socketState = "reconnecting";
    s.lastHeartbeat = { receivedAt: "", liveEventId: 7, isActive: true };
    const rest = createFakeRest();
    rest.nextLocation({
      ok: true,
      status: 201,
      seq: 1,
      published: true,
      receivedAt: "2026-12-22T01:31:07.100Z",
      serverTime: "2026-12-22T01:31:07.100Z",
    });
    let clock = 20_000;
    const now = () => clock;
    const hub = new FakeHubClient();
    let hubEnabled = false;
    const loop = startSendLoop({
      state: s,
      rest,
      getHub: () => (hubEnabled ? hub : null),
      ingestChannel: "x:ingest",
      intervalMs: 60_000,
      httpFallbackIntervalMs: 1000,
      now,
    });
    // First fix goes out on HTTP.
    setLatestFix(s, { ...FIX });
    await loop.tick();
    expect(rest.locationCalls).toHaveLength(1);
    // Inside the HTTP window a new fix arrives AND the socket connects; the
    // next send goes via the hub with the newest fix, not HTTP.
    clock = 20_400;
    setLatestFix(s, { ...FIX, lat: 48.0 });
    s.socketState = "connected";
    hubEnabled = true;
    const p = loop.tick();
    await Promise.resolve();
    await Promise.resolve();
    const inv = hub.lastInvoke();
    expect(inv).toBeDefined();
    expect(inv!.method).toBe("SendToChannel");
    const payload = inv!.args[2] as { lat: number };
    expect(payload.lat).toBe(48.0);
    inv!.resolve();
    await p;
    // No second HTTP POST.
    expect(rest.locationCalls).toHaveLength(1);
    loop.stop();
  });

  it("hub rejections without a live event never trigger onHubRejectionThreshold", async () => {
    const s = createBeaconState();
    s.socketState = "connected";
    s.lastHeartbeat = { receivedAt: "", liveEventId: null, isActive: true };
    const rest = createFakeRest();
    const hub = new FakeHubClient();
    let thresholdCount = 0;
    const loop = startSendLoop({
      state: s,
      rest,
      getHub: () => hub,
      ingestChannel: "x:ingest",
      intervalMs: 60_000,
      onHubRejectionThreshold: () => {
        thresholdCount += 1;
      },
    });
    for (let i = 0; i < 6; i++) {
      setLatestFix(s, { ...FIX });
      const p = loop.tick();
      await Promise.resolve();
      await Promise.resolve();
      hub.lastInvoke()!.reject(new Error("no_live_event"));
      await p;
    }
    expect(thresholdCount).toBe(0);
    loop.stop();
  });

  it("three consecutive hub rejections trigger one onHubRejectionThreshold; a delivered send resets the counter", async () => {
    const s = createBeaconState();
    s.socketState = "connected";
    s.lastHeartbeat = { receivedAt: "", liveEventId: 7, isActive: true };
    const rest = createFakeRest();
    const hub = new FakeHubClient();
    let thresholdCount = 0;
    const loop = startSendLoop({
      state: s,
      rest,
      getHub: () => hub,
      ingestChannel: "x:ingest",
      intervalMs: 60_000,
      onHubRejectionThreshold: () => {
        thresholdCount += 1;
      },
    });
    // Three rejections in a row.
    for (let i = 0; i < 3; i++) {
      setLatestFix(s, { ...FIX });
      const p = loop.tick();
      await Promise.resolve();
      await Promise.resolve();
      hub.lastInvoke()!.reject(new Error("nope"));
      await p;
    }
    expect(thresholdCount).toBe(1);
    // Now a delivered send resets the counter.
    setLatestFix(s, { ...FIX });
    let p = loop.tick();
    await Promise.resolve();
    await Promise.resolve();
    hub.lastInvoke()!.resolve();
    await p;
    // Two more rejections should NOT trigger another threshold (counter was
    // reset by the delivered send).
    for (let i = 0; i < 2; i++) {
      setLatestFix(s, { ...FIX });
      p = loop.tick();
      await Promise.resolve();
      await Promise.resolve();
      hub.lastInvoke()!.reject(new Error("nope"));
      await p;
    }
    expect(thresholdCount).toBe(1);
    loop.stop();
  });

  it("advances backoff without a maximum (5 s tail repeats)", async () => {
    const s = createBeaconState();
    setLatestFix(s, FIX);
    s.socketState = "reconnecting";
    s.lastHeartbeat = { receivedAt: "", liveEventId: 7, isActive: true };
    const rest = createFakeRest();
    for (let i = 0; i < 6; i++) {
      rest.nextLocation({
        ok: false,
        status: 500,
        code: null,
        message: null,
        requestId: null,
        serverTime: null,
      });
    }
    // Advance the clock past the HTTP window between each tick so every tick
    // is a real POST rather than a window-wait.
    let clock = 0;
    const loop = startSendLoop({
      state: s,
      rest,
      getHub: () => null,
      ingestChannel: "x:ingest",
      intervalMs: 60_000,
      httpFallbackIntervalMs: 1000,
      now: () => clock,
    });
    for (let i = 0; i < 6; i++) {
      clock += 2000;
      await loop.tick();
    }
    // Attempt has grown past the four-entry backoff table without saturating.
    expect(loop.attempt()).toBeGreaterThanOrEqual(6);
    expect(s.sendsFailedSinceBoot).toBe(6);
    loop.stop();
  });
});
