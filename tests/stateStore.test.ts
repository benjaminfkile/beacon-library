// State store: load, update with the version it read, re-read and re-apply on
// state_version_conflict up to five writes, other failures leave current()
// unchanged, writes run one after another, and refreshIfBehind reloads only
// when the given version is ahead. Runs against the fake REST client's
// in-memory document.

import { describe, expect, it } from "vitest";
import type { BeaconLogger } from "../src/logger.js";
import type { Rest } from "../src/rest.js";
import { createStateStore, StateStoreError } from "../src/stateStore.js";
import { createFakeRest } from "../src/testing.js";

interface Doc {
  mode: string;
  cursor: number;
  tags: string[];
}

const empty = (): Doc => ({ mode: "idle", cursor: 0, tags: [] });

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

describe("state store (contracts 4.2 and 9.5)", () => {
  it("reads a null document as empty() at version 0", async () => {
    const rest = createFakeRest();
    const { log } = makeLog();
    const store = createStateStore({ rest, log, empty });
    expect(store.current()).toBeNull();
    const loaded = await store.load();
    expect(loaded).toEqual({ state: empty(), version: 0 });
    expect(store.current()).toEqual({ state: empty(), version: 0 });
  });

  it("writes with version 0 and gets 1", async () => {
    const rest = createFakeRest();
    const { log } = makeLog();
    const store = createStateStore({ rest, log, empty });
    await store.load();
    const res = await store.update((s) => {
      s.mode = "replay";
    });
    expect(res).toEqual({ state: { mode: "replay", cursor: 0, tags: [] }, version: 1 });
    expect(rest.stateCalls.filter((c) => c.method === "put")).toEqual([
      { method: "put", state: { mode: "replay", cursor: 0, tags: [] }, expectedVersion: 0 },
    ]);
    expect(rest.state).toEqual({ mode: "replay", cursor: 0, tags: [] });
    expect(rest.stateVersion).toBe(1);
    expect(store.current()).toEqual(res);
  });

  it("loads first when update is called with no current copy", async () => {
    const rest = createFakeRest();
    rest.setState({ mode: "live", cursor: 3, tags: [] }, 4);
    const { log } = makeLog();
    const store = createStateStore({ rest, log, empty });
    const res = await store.update((s) => ({ ...s, cursor: s.cursor + 1 }));
    expect(res).toEqual({ state: { mode: "live", cursor: 4, tags: [] }, version: 5 });
    expect(rest.stateCalls.map((c) => c.method)).toEqual(["get", "put"]);
  });

  it("does not let the mutator touch the current copy", async () => {
    const rest = createFakeRest();
    const { log } = makeLog();
    const store = createStateStore({ rest, log, empty });
    await store.load();
    rest.nextStateError({
      ok: false,
      status: 503,
      code: null,
      message: null,
      requestId: null,
      serverTime: null,
    });
    await expect(
      store.update((s) => {
        s.tags.push("x");
      }),
    ).rejects.toBeInstanceOf(StateStoreError);
    expect(store.current()).toEqual({ state: empty(), version: 0 });
  });

  it("re-reads and re-applies the mutator on a conflict, keeping both changes", async () => {
    const rest = createFakeRest();
    const { lines, log } = makeLog();
    const store = createStateStore({ rest, log, empty });
    await store.load();
    // Another instance writes after this one read.
    rest.setState({ mode: "replay", cursor: 0, tags: ["other"] }, 1);
    let calls = 0;
    const res = await store.update((s) => {
      calls++;
      s.tags.push("mine");
    });
    expect(calls).toBe(2);
    expect(res).toEqual({ state: { mode: "replay", cursor: 0, tags: ["other", "mine"] }, version: 2 });
    expect(rest.state).toEqual({ mode: "replay", cursor: 0, tags: ["other", "mine"] });
    expect(rest.stateCalls.map((c) => [c.method, c.expectedVersion])).toEqual([
      ["get", undefined],
      ["put", 0],
      ["get", undefined],
      ["put", 1],
    ]);
    expect(lines).toEqual([
      { level: "info", fields: { attempt: 1, currentVersion: 1 }, msg: "state conflict; retrying" },
    ]);
  });

  it("rejects with state_conflict after five conflicts in a row", async () => {
    const fake = createFakeRest();
    const rest: Pick<Rest, "getState" | "putState"> = {
      getState: () => fake.getState(),
      putState: (state, expectedVersion) => {
        // Another writer lands just before every write.
        fake.setState({ mode: "other", cursor: fake.stateVersion + 1, tags: [] }, fake.stateVersion + 1);
        return fake.putState(state, expectedVersion);
      },
    };
    const { lines, log } = makeLog();
    const store = createStateStore({ rest, log, empty });
    await store.load();
    const err = await store
      .update((s) => {
        s.mode = "mine";
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as StateStoreError).code).toBe("state_conflict");
    expect(fake.stateCalls.filter((c) => c.method === "put")).toHaveLength(5);
    expect(lines.filter((l) => l.msg === "state conflict; retrying").map((l) => l.fields.attempt)).toEqual([
      1, 2, 3, 4,
    ]);
    expect(lines.at(-1)).toEqual({
      level: "warn",
      fields: { code: "state_conflict", status: 409 },
      msg: "state write failed",
    });
  });

  it("rejects a 503 with code and status and leaves current() unchanged", async () => {
    const rest = createFakeRest();
    const { lines, log } = makeLog();
    const store = createStateStore({ rest, log, empty });
    await store.update((s) => {
      s.cursor = 9;
    });
    const before = store.current();
    rest.nextStateError({
      ok: false,
      status: 503,
      code: "unavailable",
      message: null,
      requestId: null,
      serverTime: null,
    });
    const err = await store
      .update((s) => {
        s.cursor = 10;
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as StateStoreError).code).toBe("unavailable");
    expect((err as StateStoreError).status).toBe(503);
    expect(store.current()).toEqual(before);
    expect(rest.stateVersion).toBe(1);
    expect(lines.at(-1)).toEqual({
      level: "warn",
      fields: { code: "unavailable", status: 503 },
      msg: "state write failed",
    });
  });

  it("rejects a transport failure with code transport_error and status null", async () => {
    const rest = createFakeRest();
    const { log } = makeLog();
    const store = createStateStore({ rest, log, empty });
    await store.load();
    rest.nextStateError({
      ok: false,
      status: null,
      code: null,
      message: null,
      requestId: null,
      serverTime: null,
      transportError: "fetch failed",
    });
    const err = (await store.update(() => undefined).catch((e: unknown) => e)) as StateStoreError;
    expect(err.code).toBe("transport_error");
    expect(err.status).toBeNull();
    expect(store.current()).toEqual({ state: empty(), version: 0 });
  });

  it("runs two concurrent updates one after the other, and both land", async () => {
    const fake = createFakeRest();
    let inFlight = 0;
    let maxInFlight = 0;
    const rest: Pick<Rest, "getState" | "putState"> = {
      getState: () => fake.getState(),
      putState: async (state, expectedVersion) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return fake.putState(state, expectedVersion);
      },
    };
    const { lines, log } = makeLog();
    const store = createStateStore({ rest, log, empty });
    const [a, b] = await Promise.all([
      store.update((s) => {
        s.tags.push("a");
      }),
      store.update((s) => {
        s.tags.push("b");
      }),
    ]);
    expect(maxInFlight).toBe(1);
    expect(a.version).toBe(1);
    expect(b).toEqual({ state: { mode: "idle", cursor: 0, tags: ["a", "b"] }, version: 2 });
    expect(fake.stateCalls.filter((c) => c.method === "put").map((c) => c.expectedVersion)).toEqual([0, 1]);
    expect(lines).toEqual([]);
  });

  it("refreshIfBehind reloads only when the version is ahead", async () => {
    const rest = createFakeRest();
    const { log } = makeLog();
    const store = createStateStore({ rest, log, empty });
    await store.update((s) => {
      s.cursor = 1;
    });
    const gets = () => rest.stateCalls.filter((c) => c.method === "get").length;
    const before = gets();

    await store.refreshIfBehind(null);
    await store.refreshIfBehind(undefined);
    await store.refreshIfBehind(0);
    await store.refreshIfBehind(1);
    expect(gets()).toBe(before);

    rest.setState({ mode: "other", cursor: 7, tags: [] }, 2);
    await store.refreshIfBehind(2);
    expect(gets()).toBe(before + 1);
    expect(store.current()).toEqual({ state: { mode: "other", cursor: 7, tags: [] }, version: 2 });
  });

  it("never logs the document", async () => {
    const rest = createFakeRest();
    const { lines, log } = makeLog();
    const store = createStateStore({ rest, log, empty });
    await store.load();
    rest.setState({ mode: "secret-mode", cursor: 0, tags: [] }, 1);
    await store.update((s) => {
      s.tags.push("secret-tag");
    });
    rest.nextStateError({
      ok: false,
      status: 413,
      code: "payload_too_large",
      message: null,
      requestId: null,
      serverTime: null,
    });
    await store.update((s) => s).catch(() => undefined);
    expect(lines.length).toBeGreaterThan(0);
    expect(JSON.stringify(lines)).not.toContain("secret");
  });
});
