// Heartbeat loop: body validates against the vendored heartbeat.schema.json;
// 401 sets revoked without stopping any loop; skew is computed from the
// request midpoint.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import { startHeartbeatLoop } from "../src/heartbeatLoop.js";
import { createBeaconState } from "../src/state.js";
import { createFakeRest } from "./fakes.js";

const schema = JSON.parse(
  readFileSync(join(process.cwd(), "contracts/schema/heartbeat.schema.json"), "utf8"),
);
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats.default(ajv);
const validate = ajv.compile(schema);

describe("heartbeat loop (contracts 9.2 + 4.2)", () => {
  it("body validates against the vendored heartbeat schema", async () => {
    const state = createBeaconState();
    state.socketState = "connected";
    const rest = createFakeRest();
    rest.nextHeartbeat({
      ok: true,
      status: 200,
      receivedAt: "2026-12-22T01:31:07.100Z",
      liveEventId: 7,
      isActive: true,
      serverTime: "2026-12-22T01:31:07.100Z",
      tSendMs: 0,
      tReceiveMs: 0,
    });
    const loop = startHeartbeatLoop({
      state,
      rest,
      intervalMs: 60_000,
      buildHealth: () => ({
        batteryPercent: null,
        lastFixAgeS: 3,
        socketState: state.socketState,
      }),
      buildDebug: () => ({ source: { url: "https://x" } }),
    });
    await loop.tick();
    const call = rest.heartbeatCalls[0]!;
    const ok = validate(call.body);
    if (!ok) console.error(validate.errors);
    expect(ok).toBe(true);
    loop.stop();
  });

  it("computes clockSkewMs from the request midpoint", async () => {
    const state = createBeaconState();
    const rest = createFakeRest();
    // Fake rest fills tSend/tReceive around Date.now() at call time; script
    // a serverTime 500 ms after "now" so skew is around +450..+550 ms.
    const now = Date.now();
    rest.nextHeartbeat({
      ok: true,
      status: 200,
      receivedAt: "",
      liveEventId: null,
      isActive: false,
      serverTime: new Date(now + 500).toISOString(),
      tSendMs: 0,
      tReceiveMs: 0,
    });
    const loop = startHeartbeatLoop({ state, rest, intervalMs: 60_000 });
    await loop.tick();
    expect(state.clockSkewMs).not.toBeNull();
    expect(Math.abs((state.clockSkewMs ?? 0) - 500)).toBeLessThan(200);
    loop.stop();
  });

  it("sets revoked on 401 without stopping any loop", async () => {
    const state = createBeaconState();
    const rest = createFakeRest();
    rest.nextHeartbeat({
      ok: false,
      status: 401,
      code: "unauthenticated",
      message: "",
      requestId: "req-1",
      serverTime: null,
    });
    let revokedFired = false;
    const loop = startHeartbeatLoop({
      state,
      rest,
      intervalMs: 60_000,
      onRevoked: () => (revokedFired = true),
    });
    await loop.tick();
    expect(state.revoked).toBe(true);
    expect(revokedFired).toBe(true);
    loop.stop();
  });

  it("leaves liveEventId, isActive, and clockSkewMs unchanged on other errors", async () => {
    const state = createBeaconState();
    state.lastHeartbeat = { receivedAt: "prev", liveEventId: 7, isActive: true };
    state.clockSkewMs = 42;
    const rest = createFakeRest();
    rest.nextHeartbeat({
      ok: false,
      status: 500,
      code: null,
      message: null,
      requestId: null,
      serverTime: null,
    });
    const loop = startHeartbeatLoop({ state, rest, intervalMs: 60_000 });
    await loop.tick();
    expect(state.lastHeartbeat).toEqual({ receivedAt: "prev", liveEventId: 7, isActive: true });
    expect(state.clockSkewMs).toBe(42);
    expect(state.revoked).toBe(false);
    loop.stop();
  });
});
