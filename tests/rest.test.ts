// REST client: the state document calls carry X-Beacon-Key and read the
// answer; a 409 maps to state_version_conflict with currentVersion from
// details.stateVersion; a 401 on either call marks the state revoked; the
// heartbeat answer's stateVersion is read.

import { describe, expect, it } from "vitest";
import { createRest } from "../src/rest.js";
import { createBeaconState } from "../src/state.js";

interface Seen {
  url: string;
  init: RequestInit;
}

function stubFetch(status: number, body: unknown): { seen: Seen[]; fetchImpl: typeof fetch } {
  const seen: Seen[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { seen, fetchImpl };
}

const base = { apiBaseUrl: "https://api.example.test/", key: "wbk_test" };

describe("rest: the state document (contracts 4.2)", () => {
  it("getState reads the document and sends the key", async () => {
    const { seen, fetchImpl } = stubFetch(200, {
      state: { mode: "replay" },
      stateVersion: 3,
      updatedAt: "2026-12-22T01:31:07.000Z",
      serverTime: "2026-12-22T01:31:08.000Z",
    });
    const rest = createRest({ ...base, fetchImpl });
    const res = await rest.getState();
    expect(res).toEqual({
      ok: true,
      status: 200,
      state: { mode: "replay" },
      stateVersion: 3,
      updatedAt: "2026-12-22T01:31:07.000Z",
      serverTime: "2026-12-22T01:31:08.000Z",
    });
    expect(seen[0]!.url).toBe("https://api.example.test/beacons/me/state");
    expect(seen[0]!.init.method).toBe("GET");
    expect((seen[0]!.init.headers as Record<string, string>)["X-Beacon-Key"]).toBe("wbk_test");
  });

  it("getState reads a null document before the first write", async () => {
    const { fetchImpl } = stubFetch(200, {
      state: null,
      stateVersion: 0,
      updatedAt: null,
      serverTime: "2026-12-22T01:31:08.000Z",
    });
    const res = await createRest({ ...base, fetchImpl }).getState();
    expect(res).toMatchObject({ ok: true, state: null, stateVersion: 0, updatedAt: null });
  });

  it("putState sends state and expectedVersion and reads the new version", async () => {
    const { seen, fetchImpl } = stubFetch(200, {
      stateVersion: 4,
      updatedAt: "2026-12-22T01:31:07.000Z",
      serverTime: "2026-12-22T01:31:08.000Z",
    });
    const res = await createRest({ ...base, fetchImpl }).putState({ mode: "live" }, 3);
    expect(res).toEqual({
      ok: true,
      status: 200,
      stateVersion: 4,
      updatedAt: "2026-12-22T01:31:07.000Z",
      serverTime: "2026-12-22T01:31:08.000Z",
    });
    expect(seen[0]!.init.method).toBe("PUT");
    expect(JSON.parse(seen[0]!.init.body as string)).toEqual({
      state: { mode: "live" },
      expectedVersion: 3,
    });
    expect((seen[0]!.init.headers as Record<string, string>)["X-Beacon-Key"]).toBe("wbk_test");
  });

  it("maps a 409 to state_version_conflict with currentVersion", async () => {
    const { fetchImpl } = stubFetch(409, {
      code: "state_version_conflict",
      message: "the state document has a newer version",
      details: { stateVersion: 7 },
      requestId: "req-9",
    });
    const res = await createRest({ ...base, fetchImpl }).putState({}, 3);
    expect(res).toEqual({
      ok: false,
      status: 409,
      code: "state_version_conflict",
      message: "the state document has a newer version",
      requestId: "req-9",
      serverTime: null,
      currentVersion: 7,
    });
  });

  it("a 401 on getState or putState marks the state revoked", async () => {
    const body = { code: "unauthenticated", message: "revoked", details: null, requestId: "r" };
    for (const call of ["get", "put"] as const) {
      const state = createBeaconState();
      const { fetchImpl } = stubFetch(401, body);
      const rest = createRest({ ...base, fetchImpl, state });
      const res = call === "get" ? await rest.getState() : await rest.putState({}, 0);
      expect(res).toMatchObject({ ok: false, status: 401, code: "unauthenticated" });
      expect(state.revoked).toBe(true);
    }
  });

  it("other failures leave revoked alone", async () => {
    const state = createBeaconState();
    const { fetchImpl } = stubFetch(429, { code: "rate_limited", message: "", details: null, requestId: "r" });
    const res = await createRest({ ...base, fetchImpl, state }).getState();
    expect(res).toMatchObject({ ok: false, status: 429, code: "rate_limited" });
    expect(state.revoked).toBe(false);
  });

  it("a transport failure answers status null with the error text", async () => {
    const fetchImpl = (async () => {
      throw new Error("connect refused");
    }) as unknown as typeof fetch;
    const res = await createRest({ ...base, fetchImpl }).putState({}, 0);
    expect(res).toMatchObject({ ok: false, status: null, code: null, transportError: "connect refused" });
  });

  it("the heartbeat answer's stateVersion is read", async () => {
    const { fetchImpl } = stubFetch(200, {
      receivedAt: "2026-12-22T01:31:07.000Z",
      liveEventId: 7,
      isActive: true,
      stateVersion: 4,
      serverTime: "2026-12-22T01:31:07.000Z",
    });
    const res = await createRest({ ...base, fetchImpl }).postHeartbeat({ sentAt: "2026-12-22T01:31:07.000Z" });
    expect(res).toMatchObject({ ok: true, stateVersion: 4 });
  });
});
