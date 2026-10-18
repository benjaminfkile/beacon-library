// The beacon's state document (contracts 4.2 and 9.5) behind a small store:
// load it, keep the last copy read or written, and write changes with the
// version they were based on. A 409 state_version_conflict means another
// writer got there first: the store reads the document again, applies the
// same change to the fresh copy, and writes with the new version, up to
// maxAttempts writes in all. Every load, update, and refresh runs on one
// queue, so a second call waits for the first. The document itself is never
// logged.

import type { BeaconLogger } from "./logger.js";
import type { Rest, RestError } from "./rest.js";

export interface StateSnapshot<T> {
  state: T;
  version: number;
}

export interface StateStoreOptions<T extends object> {
  rest: Pick<Rest, "getState" | "putState">;
  log: BeaconLogger;
  // The document a beacon starts from when none has been written yet.
  empty: () => T;
  // Writes per update, the first included, before giving up on conflicts.
  maxAttempts?: number;
}

export interface StateStore<T extends object> {
  load(): Promise<StateSnapshot<T>>;
  current(): StateSnapshot<T> | null;
  update(mutator: (s: T) => T | void): Promise<StateSnapshot<T>>;
  // Reloads when `version` is a number ahead of the current copy (or there is
  // no copy yet). A failed reload is logged and leaves the copy as it was;
  // the promise always resolves.
  refreshIfBehind(version: number | null | undefined): Promise<void>;
}

// The error a store call rejects with: `code` is the API's error code,
// `state_conflict` when every attempt met a newer version, `transport_error`
// when no answer arrived, or `http_error` for an answer without a code.
export class StateStoreError extends Error {
  readonly code: string;
  readonly status: number | null;
  constructor(code: string, status: number | null, message: string) {
    super(message);
    this.name = "StateStoreError";
    this.code = code;
    this.status = status;
  }
}

export const STATE_STORE_MAX_ATTEMPTS = 5;

function fromRestError(e: RestError, what: string): StateStoreError {
  const code = e.code ?? (e.status === null ? "transport_error" : "http_error");
  const detail = e.status === null ? (e.transportError ?? "no answer") : `HTTP ${e.status}`;
  return new StateStoreError(code, e.status, `${what} failed: ${code} (${detail})`);
}

function copy<T>(s: StateSnapshot<T>): StateSnapshot<T> {
  return { state: structuredClone(s.state), version: s.version };
}

export function createStateStore<T extends object>(opts: StateStoreOptions<T>): StateStore<T> {
  const { rest, log } = opts;
  const maxAttempts = Math.max(1, opts.maxAttempts ?? STATE_STORE_MAX_ATTEMPTS);
  let held: StateSnapshot<T> | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  function enqueue<R>(task: () => Promise<R>): Promise<R> {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  }

  async function read(): Promise<StateSnapshot<T>> {
    const res = await rest.getState();
    if (!res.ok) throw fromRestError(res, "state read");
    const state = res.state === null ? opts.empty() : (res.state as T);
    held = { state, version: res.stateVersion };
    return held;
  }

  async function write(mutator: (s: T) => T | void): Promise<StateSnapshot<T>> {
    let base = held ?? (await read());
    for (let attempt = 1; ; attempt++) {
      const draft = structuredClone(base.state);
      const returned = mutator(draft);
      const next = returned === undefined ? draft : returned;
      const res = await rest.putState(next, base.version);
      if (res.ok) {
        held = { state: structuredClone(next), version: res.stateVersion };
        return held;
      }
      if (res.code !== "state_version_conflict") throw fromRestError(res, "state write");
      if (attempt >= maxAttempts) {
        throw new StateStoreError(
          "state_conflict",
          res.status,
          `state write failed: a newer version on each of ${maxAttempts} attempts`,
        );
      }
      log.info({ attempt, currentVersion: res.currentVersion ?? null }, "state conflict; retrying");
      base = await read();
    }
  }

  // Logs a store error (a throwing mutator is passed through unlogged).
  function logFailure(err: unknown, msg: string): void {
    if (err instanceof StateStoreError) log.warn({ code: err.code, status: err.status }, msg);
  }

  return {
    load() {
      return enqueue(async () => {
        try {
          return copy(await read());
        } catch (err) {
          logFailure(err, "state read failed");
          throw err;
        }
      });
    },
    current() {
      return held ? copy(held) : null;
    },
    update(mutator) {
      return enqueue(async () => {
        const before = held;
        try {
          return copy(await write(mutator));
        } catch (err) {
          if (!(err instanceof StateStoreError && err.code === "state_conflict")) held = before;
          logFailure(err, "state write failed");
          throw err;
        }
      });
    },
    refreshIfBehind(version) {
      return enqueue(async () => {
        if (typeof version !== "number") return;
        if (held && version <= held.version) return;
        try {
          await read();
        } catch (err) {
          logFailure(err, "state read failed");
        }
      });
    },
  };
}
