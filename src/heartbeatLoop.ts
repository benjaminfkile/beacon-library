// Heartbeat loop per contracts 9.2: every 15 s, HTTP only, whatever the socket
// state. On 2xx: compute clockSkewMs from the request midpoint, store
// liveEventId and isActive. On 401: mark the service revoked, keep every loop
// running unchanged. Anything else leaves state unchanged and logs the code
// and requestId when present.

import type { BeaconState } from "./state.js";
import type { HealthCore, HeartbeatBody, Rest } from "./rest.js";

export interface HeartbeatLoopOptions {
  state: BeaconState;
  rest: Rest;
  intervalMs?: number;
  now?: () => number;
  isoNow?: () => string;
  buildHealth?: () => HealthCore | null;
  buildDebug?: () => Record<string, unknown> | null;
  onError?: (code: string | null, requestId: string | null) => void;
  onRevoked?: () => void;
  onBeat?: (skewMs: number | null) => void;
}

export interface HeartbeatLoop {
  stop(): void;
  tick(): Promise<void>;
}

export function startHeartbeatLoop(opts: HeartbeatLoopOptions): HeartbeatLoop {
  const intervalMs = opts.intervalMs ?? 15_000;
  const now = opts.now ?? (() => Date.now());
  const isoNow = opts.isoNow ?? (() => new Date(now()).toISOString());
  const state = opts.state;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function schedule(ms: number) {
    if (timer) clearTimeout(timer);
    if (stopped) return;
    timer = setTimeout(() => void tick(), ms);
  }

  async function tick(): Promise<void> {
    if (stopped) return;
    const body: HeartbeatBody = {
      sentAt: isoNow(),
      health: opts.buildHealth ? opts.buildHealth() : { socketState: state.socketState },
      debug: opts.buildDebug ? opts.buildDebug() : null,
    };
    try {
      const res = await opts.rest.postHeartbeat(body);
      if (res.ok) {
        const midpoint = res.tSendMs + (res.tReceiveMs - res.tSendMs) / 2;
        const serverMs = Date.parse(res.serverTime);
        state.clockSkewMs = Number.isFinite(serverMs) ? serverMs - midpoint : null;
        state.lastHeartbeat = {
          receivedAt: res.receivedAt,
          liveEventId: res.liveEventId,
          isActive: res.isActive,
        };
        opts.onBeat?.(state.clockSkewMs);
      } else if (res.status === 401) {
        state.revoked = true;
        opts.onRevoked?.();
        opts.onError?.(res.code, res.requestId);
      } else {
        opts.onError?.(res.code, res.requestId);
      }
    } finally {
      schedule(intervalMs);
    }
  }

  schedule(intervalMs);

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    tick,
  };
}
