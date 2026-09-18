// The conformance scenarios of docs/beacon-library.md section 5. Every
// scenario runs against startSocketLoop with vitest fake timers and a scripted
// fake hub. A step kind or expectation key the runner does not know fails
// that scenario.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startSocketLoop } from "../src/socketLoop.js";
import { createBeaconState } from "../src/state.js";
import type { HubClient } from "../src/hub.js";

const INGEST_CHANNEL = "wmsfo-api:ingest";
const BEACON_KEY = "wbk_conformance";

const HUB_STEP_KINDS = new Set([
  "startResolves",
  "startRejects",
  "startNeverSettles",
  "joinResolves",
  "joinDenied",
  "joinRejects",
  "joinNeverSettles",
  "close",
  "evict",
  "buildThrows",
]);

const EXPECT_STATES = new Set(["connected", "connecting", "reconnecting", "disconnected"]);
const EXPECT_KEYS_ALLOWED = new Set([
  "expect",
  "reconnectCount",
  "rejoinCount",
  "delayMs",
  "hubsBuilt",
]);

interface HubStep {
  hub: string;
  error?: string;
  reason?: string;
}
interface AdvanceStep {
  advanceMs: number;
}
interface RejoinStep {
  rejoin: true;
}
interface StopStep {
  stop: true;
}
interface ExpectStep {
  expect: string;
  reconnectCount?: number;
  rejoinCount?: number;
  delayMs?: number;
  hubsBuilt?: number;
}
type Step = HubStep | AdvanceStep | RejoinStep | StopStep | ExpectStep;

interface Scenario {
  name: string;
  steps: Step[];
}

interface Doc {
  schemaVersion: number;
  backoffMs: number[];
  joinDeniedFirstWaitMs: number;
  scenarios: Scenario[];
}

const scenariosPath = join(process.cwd(), "conformance", "scenarios.json");
const schemaPath = join(process.cwd(), "conformance", "scenarios.schema.json");
const doc: Doc = JSON.parse(readFileSync(scenariosPath, "utf8"));
const schema = JSON.parse(readFileSync(schemaPath, "utf8"));

describe("conformance scenarios", () => {
  it("scenarios.json validates against scenarios.schema.json", () => {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    const validate = ajv.compile(schema);
    const ok = validate(doc);
    if (!ok) console.error(validate.errors);
    expect(ok).toBe(true);
  });

  it("declares constants that match the library", () => {
    expect(doc.backoffMs).toEqual([1000, 2000, 3000, 5000]);
    expect(doc.joinDeniedFirstWaitMs).toBe(10_000);
  });
});

class ScriptedHub implements HubClient {
  private startPending: { resolve: () => void; reject: (e: Error) => void } | null = null;
  private startScripted: "resolve" | "reject" | "hang" | null = null;
  private joinPending: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
  private joinScripted: Array<"resolve" | "reject" | "denied" | "hang"> = [];
  private listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  private closeHandlers: Array<(err?: Error) => void> = [];

  start(): Promise<void> {
    if (this.startScripted === "resolve") {
      this.startScripted = null;
      return Promise.resolve();
    }
    if (this.startScripted === "reject") {
      this.startScripted = null;
      return Promise.reject(new Error("start rejected"));
    }
    if (this.startScripted === "hang") {
      return new Promise<void>(() => {});
    }
    return new Promise<void>((resolve, reject) => {
      this.startPending = { resolve, reject };
    });
  }
  async stop(): Promise<void> {}
  invoke<T = unknown>(method: string, ..._args: unknown[]): Promise<T> {
    if (method !== "JoinPrivateChannel") return new Promise<T>(() => {});
    if (this.joinScripted.length > 0) {
      const kind = this.joinScripted.shift()!;
      if (kind === "resolve") return Promise.resolve(undefined as unknown as T);
      if (kind === "reject") return Promise.reject(new Error("join rejected"));
      if (kind === "denied") return Promise.reject(new Error("join denied by gateway"));
      return new Promise<T>(() => {});
    }
    return new Promise<T>((resolve, reject) => {
      this.joinPending.push({
        resolve: () => resolve(undefined as unknown as T),
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

  scriptStart(kind: "resolve" | "reject" | "hang"): void {
    if (this.startPending) {
      if (kind === "resolve") this.startPending.resolve();
      else if (kind === "reject") this.startPending.reject(new Error("start rejected"));
      if (kind !== "hang") this.startPending = null;
      return;
    }
    this.startScripted = kind;
  }
  scriptJoin(kind: "resolve" | "reject" | "denied" | "hang"): void {
    if (this.joinPending.length > 0) {
      const p = this.joinPending.shift()!;
      if (kind === "resolve") p.resolve();
      else if (kind === "reject") p.reject(new Error("join rejected"));
      else if (kind === "denied") p.reject(new Error("join denied by gateway"));
      return;
    }
    this.joinScripted.push(kind);
  }
  emitEnvelope(env: unknown): void {
    for (const h of this.listeners.get("ChannelEvent") ?? []) h(env);
  }
  triggerClose(err?: Error): void {
    for (const h of this.closeHandlers) h(err);
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

function isKnownStep(step: unknown): step is Step {
  if (!step || typeof step !== "object") return false;
  const s = step as Record<string, unknown>;
  if ("hub" in s) {
    if (typeof s.hub !== "string" || !HUB_STEP_KINDS.has(s.hub)) return false;
    const allowed = new Set(["hub", "error", "reason"]);
    for (const k of Object.keys(s)) if (!allowed.has(k)) return false;
    return true;
  }
  if ("advanceMs" in s) {
    return typeof s.advanceMs === "number" && Object.keys(s).length === 1;
  }
  if ("rejoin" in s) return s.rejoin === true && Object.keys(s).length === 1;
  if ("stop" in s) return s.stop === true && Object.keys(s).length === 1;
  if ("expect" in s) {
    if (typeof s.expect !== "string" || !EXPECT_STATES.has(s.expect)) return false;
    for (const k of Object.keys(s)) if (!EXPECT_KEYS_ALLOWED.has(k)) return false;
    return true;
  }
  return false;
}

async function runScenario(scenario: Scenario): Promise<void> {
  const state = createBeaconState();
  const hubs: ScriptedHub[] = [];
  let buildThrowsRemaining = 0;
  const logLines: Array<{ msg: string; fields: Record<string, unknown> }> = [];

  const loop = startSocketLoop({
    build: () => {
      if (buildThrowsRemaining > 0) {
        buildThrowsRemaining -= 1;
        throw new Error("build failed");
      }
      const h = new ScriptedHub();
      hubs.push(h);
      return h;
    },
    ingestChannel: INGEST_CHANNEL,
    key: BEACON_KEY,
    state,
    log: {
      info: (fields, msg) => logLines.push({ msg, fields }),
      warn: (fields, msg) => logLines.push({ msg, fields }),
    },
  });

  const currentHub = (): ScriptedHub => {
    const h = hubs[hubs.length - 1];
    if (!h) throw new Error("no current hub yet; scenario ordering issue");
    return h;
  };

  try {
    for (const rawStep of scenario.steps) {
      if (!isKnownStep(rawStep)) {
        throw new Error(`scenario '${scenario.name}': unknown step ${JSON.stringify(rawStep)}`);
      }
      const step = rawStep as Step;

      if ("hub" in step) {
        if (step.hub === "buildThrows") {
          buildThrowsRemaining += 1;
        } else {
          await flush();
          const h = currentHub();
          switch (step.hub) {
            case "startResolves":
              h.scriptStart("resolve");
              break;
            case "startRejects":
              h.scriptStart("reject");
              break;
            case "startNeverSettles":
              h.scriptStart("hang");
              break;
            case "joinResolves":
              h.scriptJoin("resolve");
              break;
            case "joinRejects":
              h.scriptJoin("reject");
              break;
            case "joinDenied":
              h.scriptJoin("denied");
              break;
            case "joinNeverSettles":
              h.scriptJoin("hang");
              break;
            case "close":
              h.triggerClose(step.error ? new Error(step.error) : undefined);
              break;
            case "evict":
              if (!step.reason) {
                throw new Error(`scenario '${scenario.name}': evict without reason`);
              }
              h.emitEnvelope({
                channel: INGEST_CHANNEL,
                event: "channelEvicted",
                data: { channel: INGEST_CHANNEL, reason: step.reason },
              });
              break;
            default:
              throw new Error(`scenario '${scenario.name}': unknown hub step ${step.hub}`);
          }
        }
        await flush();
      } else if ("advanceMs" in step) {
        await vi.advanceTimersByTimeAsync(step.advanceMs);
        await flush();
      } else if ("rejoin" in step) {
        void loop.rejoin();
        await flush();
      } else if ("stop" in step) {
        void loop.stop();
        await flush();
      } else if ("expect" in step) {
        expect(state.socketState).toBe(step.expect);
        if (step.reconnectCount !== undefined)
          expect(state.reconnectCount).toBe(step.reconnectCount);
        if (step.rejoinCount !== undefined) expect(state.rejoinCount).toBe(step.rejoinCount);
        if (step.hubsBuilt !== undefined) expect(hubs.length).toBe(step.hubsBuilt);
        if (step.delayMs !== undefined) {
          const lastClose = [...logLines]
            .reverse()
            .find((l) => l.msg === "socket closed; reconnecting");
          expect(lastClose?.fields.delayMs).toBe(step.delayMs);
        }
      }
    }
  } finally {
    await loop.stop();
    await flush();
  }
}

describe("conformance scenarios: one vitest case per scenario", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  for (const scenario of doc.scenarios) {
    it(scenario.name, async () => {
      await runScenario(scenario);
    });
  }
});
