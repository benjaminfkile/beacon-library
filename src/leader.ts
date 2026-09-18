// Leader poll per contracts 7.5: GET /internal/leader every 2 s with a 1 s
// timeout; leader only when the latest answer is 2xx, isLeader is true, and
// evaluatedAt is non-null and under 90 s old. Any failure means follower.
// `forceLeader` (local runs only) makes the node leader without a gateway.

export interface LeaderOptions {
  gatewayInternalUrl: string;
  // Null only when forceLeader is true, the forced path never polls
  // /internal/leader and does not need the token.
  realtimeToken: string | null;
  forceLeader?: boolean;
  pollMs?: number;
  timeoutMs?: number;
  expiryMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  onChange?: (leader: boolean) => void;
  // Skip the automatic loop; tests drive the poll by hand.
  autoStart?: boolean;
}

interface LeaderState {
  isLeader: boolean;
  polledOnce: boolean;
  lastEvaluatedAtMs: number | null;
  lastPollAtMs: number | null;
  lastError: string | null;
}

export interface Leader {
  isLeader(): boolean;
  polledOnce(): boolean;
  stop(): void;
  pollOnce(): Promise<void>;
}

export function startLeader(opts: LeaderOptions): Leader {
  const pollMs = opts.pollMs ?? 2000;
  const timeoutMs = opts.timeoutMs ?? 1000;
  const expiryMs = opts.expiryMs ?? 90_000;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;

  const state: LeaderState = {
    isLeader: false,
    polledOnce: false,
    lastEvaluatedAtMs: null,
    lastPollAtMs: null,
    lastError: null,
  };

  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  function set(next: boolean) {
    if (next !== state.isLeader) {
      state.isLeader = next;
      opts.onChange?.(next);
    }
  }

  async function pollOnce(): Promise<void> {
    if (opts.forceLeader) {
      state.lastPollAtMs = now();
      state.polledOnce = true;
      state.lastError = null;
      set(true);
      return;
    }
    const controller = new AbortController();
    const to = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${opts.gatewayInternalUrl}/internal/leader`, {
        method: "GET",
        headers: {
          "X-Gateway-Realtime-Token": opts.realtimeToken ?? "",
          Accept: "application/json",
        },
        signal: controller.signal,
      });
      state.lastPollAtMs = now();
      state.polledOnce = true;
      if (!res.ok) {
        state.lastError = `http ${res.status}`;
        set(false);
        return;
      }
      const body = (await res.json()) as {
        isLeader?: boolean;
        evaluatedAt?: string | null;
      };
      const evaluatedAt = body.evaluatedAt ? Date.parse(body.evaluatedAt) : NaN;
      if (!body.isLeader || !Number.isFinite(evaluatedAt)) {
        state.lastEvaluatedAtMs = Number.isFinite(evaluatedAt) ? evaluatedAt : null;
        state.lastError = null;
        set(false);
        return;
      }
      state.lastEvaluatedAtMs = evaluatedAt;
      if (now() - evaluatedAt > expiryMs) {
        state.lastError = "expired";
        set(false);
        return;
      }
      state.lastError = null;
      set(true);
    } catch (err) {
      state.lastPollAtMs = now();
      state.polledOnce = true;
      state.lastError = err instanceof Error ? err.message : String(err);
      set(false);
    } finally {
      clearTimeout(to);
    }
  }

  async function loop() {
    if (stopped) return;
    await pollOnce();
    if (stopped) return;
    timer = setTimeout(loop, pollMs);
  }

  if (opts.autoStart !== false) void loop();

  return {
    isLeader: () => state.isLeader,
    polledOnce: () => state.polledOnce,
    stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
    pollOnce,
  };
}
