// Socket loop per contracts 9.2. At most one connection; `connected` only after
// the JoinPrivateChannel invoke resolves (the joined ack); evictions re-join
// immediately (auth_expired) or force a reconnect (any other reason); any
// transport-level close, error or clean, releases the client and reconnects
// through the same backoff branch; a join denied by the gateway makes the first
// retry wait 10 s; every other close or failure takes the 1 s, 2 s, 3 s, 5 s
// backoff, and 5 s repeats forever. The loop terminates only when stop() is
// called.
//
// The gateway carries every hub message inside the single client method
// `ChannelEvent` (contracts 2.3 step 1). The envelope is routed on
// `envelope.channel` and `envelope.event`; envelopes for channels this beacon
// did not join are ignored.
//
// `rejoin()` is the same path as `channelEvicted auth_expired`, exposed for the
// send loop's three-consecutive-hub-rejections trigger (contracts 9.2). Each
// call increments `state.rejoinCount` (the transport telemetry counter), logs
// its outcome, and on failure takes the normal reconnect branch so the send
// loop falls back to HTTP until the socket is connected again.

import { backoffMs, JOIN_DENIED_FIRST_WAIT_MS } from "./backoff.js";
import type { HubClient } from "./hub.js";
import type { BeaconLogger } from "./logger.js";
import type { BeaconState } from "./state.js";

export type SocketLogger = Pick<BeaconLogger, "info" | "warn">;

export interface SocketLoopOptions {
  build: () => HubClient;
  ingestChannel: string;
  key: string;
  state: BeaconState;
  onConnected?: () => void;
  onDisconnected?: () => void;
  onBuildError?: (err: unknown) => void;
  sleep?: (ms: number) => Promise<void>;
  log?: SocketLogger;
}

export interface SocketLoop {
  stop(): Promise<void>;
  wake(): void;
  rejoin(): Promise<void>;
}

const CHANNEL_EVENT = "ChannelEvent";

function isJoinDenied(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /join.*denied|denied.*join|forbidden|401|403/i.test(msg);
}

export function startSocketLoop(opts: SocketLoopOptions): SocketLoop {
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const state = opts.state;
  let stopped = false;
  let attempt = 0;
  let current: HubClient | null = null;

  async function stopCurrent(): Promise<void> {
    if (!current) return;
    const c = current;
    current = null;
    try {
      await c.stop();
    } catch {
      // A stop() throw is fine; the socket is going away either way.
    }
  }

  function markConnected(): void {
    if (state.socketState === "connected") return;
    state.socketState = "connected";
    state.reconnectCount += 1;
    opts.log?.info(
      {
        channel: opts.ingestChannel,
        reconnectCount: state.reconnectCount,
        attempt,
      },
      "socket connected",
    );
    opts.onConnected?.();
  }

  async function tryRejoinOn(client: HubClient): Promise<void> {
    // Same path as `channelEvicted auth_expired`. Counts every re-invocation
    // whether or not it resolved (contracts 9.2 "rejoinCount ... on a still-open
    // connection"). On success the send loop wakes; on failure the socket
    // takes its close-or-failure branch so the send loop falls back to HTTP.
    state.rejoinCount += 1;
    try {
      await client.invoke("JoinPrivateChannel", opts.ingestChannel, opts.key);
      if (current === client) opts.onConnected?.();
      opts.log?.info(
        { channel: opts.ingestChannel, rejoinCount: state.rejoinCount },
        "socket rejoined",
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      opts.log?.warn(
        { channel: opts.ingestChannel, err: msg },
        "socket rejoin failed",
      );
      if (current === client) {
        attempt = 0;
        state.socketState = "reconnecting";
        opts.onDisconnected?.();
        await stopCurrent();
      }
    }
  }

  async function loop(): Promise<void> {
    while (!stopped) {
      state.socketState = "connecting";
      let client: HubClient;
      try {
        client = opts.build();
      } catch (err) {
        opts.onBuildError?.(err);
        state.socketState = "reconnecting";
        opts.onDisconnected?.();
        const delay = backoffMs(attempt);
        const msg = err instanceof Error ? err.message : String(err);
        opts.log?.info(
          {
            channel: opts.ingestChannel,
            err: msg,
            delayMs: delay,
            attempt,
          },
          "socket closed; reconnecting",
        );
        attempt += 1;
        if (delay > 0) await sleep(delay);
        continue;
      }
      current = client;
      let deniedNext = false;
      let closeErr: unknown = null;
      let cycleErr: unknown = null;
      let closed = false;
      let signalClosed: () => void = () => {};
      const closeSignal = new Promise<void>((resolve) => {
        signalClosed = resolve;
      });
      const closeRejection: Promise<never> = closeSignal.then(() => {
        throw new Error("hub connection closed");
      });
      // Swallow the rejection arm so a close that arrives after start/invoke
      // have already settled never surfaces as an unhandled promise rejection.
      closeRejection.catch(() => {});
      client.onClose((err) => {
        if (state.socketState === "connected") state.socketState = "reconnecting";
        if (current === client) {
          closeErr = err ?? null;
          closed = true;
          signalClosed();
          void stopCurrent();
        }
      });
      client.on(CHANNEL_EVENT, (envelope: unknown) => {
        if (current !== client) return;
        if (!envelope || typeof envelope !== "object") return;
        const env = envelope as {
          channel?: unknown;
          event?: unknown;
          data?: unknown;
        };
        if (env.channel !== opts.ingestChannel) return;
        if (env.event === "joined") {
          markConnected();
          return;
        }
        if (env.event === "channelEvicted") {
          const reason =
            env.data && typeof env.data === "object" && "reason" in (env.data as object)
              ? (env.data as { reason?: string }).reason
              : undefined;
          opts.log?.info(
            { channel: opts.ingestChannel, reason: reason ?? "unknown" },
            "socket evicted",
          );
          if (reason === "auth_expired") {
            void tryRejoinOn(client);
            return;
          }
          cycleErr = new Error(`evicted: ${reason ?? "unknown"}`);
          void stopCurrent();
          return;
        }
      });
      try {
        await Promise.race([client.start(), closeRejection]);
        await Promise.race([
          client.invoke("JoinPrivateChannel", opts.ingestChannel, opts.key),
          closeRejection,
        ]);
        if (current === client) {
          attempt = 0;
          markConnected();
          while (!stopped && current === client && !closed) {
            await Promise.race([sleep(1000), closeSignal]);
          }
        }
      } catch (err) {
        cycleErr = err;
        deniedNext = isJoinDenied(err);
        state.socketState = "reconnecting";
        opts.onDisconnected?.();
      } finally {
        await stopCurrent();
      }

      if (stopped) return;
      state.socketState = "reconnecting";
      opts.onDisconnected?.();
      const attemptForLog = attempt;
      let delay: number;
      if (deniedNext) {
        delay = JOIN_DENIED_FIRST_WAIT_MS;
        attempt = 1;
      } else {
        delay = backoffMs(attempt);
        attempt += 1;
      }
      const reasonErr = cycleErr ?? closeErr;
      const errMsg =
        reasonErr instanceof Error
          ? reasonErr.message
          : reasonErr != null
            ? String(reasonErr)
            : null;
      opts.log?.info(
        {
          channel: opts.ingestChannel,
          err: errMsg,
          delayMs: delay,
          attempt: attemptForLog,
        },
        "socket closed; reconnecting",
      );
      if (delay > 0) await sleep(delay);
    }
  }

  void Promise.resolve().then(loop);

  return {
    async stop() {
      stopped = true;
      await stopCurrent();
      state.socketState = "disconnected";
    },
    wake() {
      // No wake-up channel: sleep-based delays run to completion; the loop
      // reads `stopped` on every cycle. A caller who needs to break the sleep
      // early passes their own sleep() and drives it themselves.
    },
    async rejoin() {
      const c = current;
      if (!c) return;
      await tryRejoinOn(c);
    },
  };
}
