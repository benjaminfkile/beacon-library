// Send loop per contracts 9.2. Every fix interval and on a new fix:
//  - if no fix or the current fix has been delivered: return
//  - if a send is in flight: return
//  - if socketState == connected: SendToChannel; on failure keep the fix, do
//    not fall back (the socket is up); the next attempt waits backoffMs.
//  - else: POST /locations; on 2xx success; else failed send.
//  - failed send while lastHeartbeat.liveEventId is null: log at most once per
//    minute, do NOT increment sendsFailedSinceBoot.
//  - failed send otherwise: increment sendsFailedSinceBoot and attempt.
//
// The HTTP window (contracts 9.2): an HTTP send starts no sooner than
// HTTP_FALLBACK_INTERVAL_MS after the previous HTTP send started; a fix
// arriving inside the window replaces latestFix and the newest goes out when
// the window ends; a socket that connects during the window takes the fix.
// The hub door has no window.
//
// Three consecutive hub rejections while `socketState == connected` ask the
// socket loop to re-join the ingest channel once via `onHubRejectionThreshold`;
// the counter resets on any delivered send. The rejoin path is the same as
// `channelEvicted auth_expired` (see socketLoop.ts).

import { backoffMs } from "./backoff.js";
import type { HubClient } from "./hub.js";
import type { LatestFix, BeaconState } from "./state.js";
import type { LocationBody, Rest } from "./rest.js";

export const HTTP_FALLBACK_INTERVAL_MS = 1000;
export const HUB_REJECTION_REJOIN_THRESHOLD = 3;

export interface SendLoopOptions {
  state: BeaconState;
  rest: Rest;
  getHub: () => HubClient | null;
  ingestChannel: string;
  intervalMs?: number;
  httpFallbackIntervalMs?: number;
  now?: () => number;
  onSent?: (fix: LatestFix, viaHub: boolean, receiptLatencyMs: number) => void;
  onFailed?: (viaHub: boolean, reason: string) => void;
  onHubRejectionThreshold?: () => void;
}

export type SendDecision =
  | { action: "skip"; reason: "no-fix" | "already-delivered" | "in-flight" }
  | { action: "hub" }
  | { action: "http" };

export function decide(state: BeaconState, inFlight: boolean): SendDecision {
  if (!state.latestFix) return { action: "skip", reason: "no-fix" };
  if (state.latestFix.seqLocal === state.lastDeliveredSeqLocal)
    return { action: "skip", reason: "already-delivered" };
  if (inFlight) return { action: "skip", reason: "in-flight" };
  if (state.socketState === "connected") return { action: "hub" };
  return { action: "http" };
}

function toBody(f: LatestFix): LocationBody {
  return {
    lat: f.lat,
    lng: f.lng,
    recordedAt: f.recordedAt,
    speedMps: f.speedMps,
    altitudeM: f.altitudeM,
    headingDeg: f.headingDeg,
    accuracyM: f.accuracyM,
  };
}

export interface SendLoop {
  wake(): void;
  stop(): void;
  tick(): Promise<void>;
  inFlight(): boolean;
  attempt(): number;
}

export function startSendLoop(opts: SendLoopOptions): SendLoop {
  const intervalMs = opts.intervalMs ?? 1000;
  const httpWindowMs = opts.httpFallbackIntervalMs ?? HTTP_FALLBACK_INTERVAL_MS;
  const now = opts.now ?? (() => Date.now());
  const state = opts.state;
  let inFlight = false;
  let attempt = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let noLiveLoggedAt = 0;
  let lastHttpSendStartedAt = -Infinity;
  let consecutiveHubRejections = 0;

  function schedule(ms: number) {
    if (timer) clearTimeout(timer);
    if (stopped) return;
    timer = setTimeout(() => void tick(), Math.max(0, ms));
  }

  async function tick(): Promise<void> {
    if (stopped) return;
    const decision = decide(state, inFlight);
    if (decision.action === "skip") {
      schedule(intervalMs);
      return;
    }
    if (decision.action === "http") {
      const remaining = httpWindowMs - (now() - lastHttpSendStartedAt);
      if (remaining > 0) {
        // Wait out the HTTP window; when it ends we re-decide (a fix arriving
        // meanwhile is already in `latestFix`; a socket that connects during
        // the window will take the fix).
        schedule(remaining);
        return;
      }
    }
    const fix = state.latestFix!;
    inFlight = true;
    const started = now();
    try {
      if (decision.action === "hub") {
        const hub = opts.getHub();
        if (!hub) {
          onFail(true, "no-hub");
          return;
        }
        try {
          await hub.invoke("SendToChannel", opts.ingestChannel, "location", toBody(fix));
          onOk(fix, true, now() - started);
        } catch (err) {
          onFail(true, err instanceof Error ? err.message : String(err));
        }
      } else {
        lastHttpSendStartedAt = started;
        const res = await opts.rest.postLocation(toBody(fix));
        if (res.ok) {
          state.httpFallbackSeconds += (now() - started) / 1000;
          onOk(fix, false, now() - started);
        } else {
          onFail(false, res.code ?? String(res.status ?? res.transportError ?? "http-error"));
        }
      }
    } finally {
      inFlight = false;
    }
  }

  function onOk(fix: LatestFix, viaHub: boolean, latency: number): void {
    state.lastDeliveredSeqLocal = fix.seqLocal;
    state.lastReceiptLatencyMs = latency;
    attempt = 0;
    consecutiveHubRejections = 0;
    opts.onSent?.(fix, viaHub, latency);
    // A new fix may already be waiting; try again immediately.
    schedule(0);
  }

  function onFail(viaHub: boolean, reason: string): void {
    const hasLiveEvent = state.lastHeartbeat?.liveEventId != null;
    if (hasLiveEvent) {
      state.sendsFailedSinceBoot += 1;
    } else {
      const nowMs = now();
      if (nowMs - noLiveLoggedAt >= 60_000) {
        noLiveLoggedAt = nowMs;
      }
    }
    opts.onFailed?.(viaHub, reason);
    // Contracts 9.2: rejections count toward a re-join only while the heartbeat
    // names a live event; without one every hub send is rejected by design.
    if (viaHub && state.socketState === "connected" && hasLiveEvent) {
      consecutiveHubRejections += 1;
      if (consecutiveHubRejections >= HUB_REJECTION_REJOIN_THRESHOLD) {
        consecutiveHubRejections = 0;
        try {
          opts.onHubRejectionThreshold?.();
        } catch {
          // The socket loop takes its own failure branch inside rejoin(); a
          // callback throw shouldn't escape into the send loop.
        }
      }
    } else {
      // A failure via HTTP does not add to the hub-rejection counter, but a
      // hub failure while the socket is not `connected` shouldn't either.
    }
    const wait = backoffMs(attempt);
    attempt += 1;
    schedule(wait);
  }

  schedule(intervalMs);

  return {
    wake() {
      schedule(0);
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    tick,
    inFlight: () => inFlight,
    attempt: () => attempt,
  };
}
