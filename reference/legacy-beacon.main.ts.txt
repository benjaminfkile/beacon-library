// Boot: load config, start the health server, start the leader poll, start the
// beacon core on the leader. The legacy Heroku poller is the fix source; the
// heartbeat carries the `health` core and the `debug` object of
// legacy-beacon.md section 5.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { loadConfig, ConfigError } from "./config.js";
import { startLeader, type Leader } from "./leader.js";
import { startHealthServer } from "./health.js";
import { createBeaconState } from "./beacon/state.js";
import { createRest } from "./beacon/rest.js";
import { buildHubClient, type HubClient } from "./beacon/hub.js";
import { startSocketLoop, type SocketLoop } from "./beacon/socketLoop.js";
import { startSendLoop, type SendLoop } from "./beacon/sendLoop.js";
import { startHeartbeatLoop, type HeartbeatLoop } from "./beacon/heartbeatLoop.js";
import { createPoller, type Poller } from "./source/poller.js";
import { buildHeartbeatDebug, buildHeartbeatHealth } from "./heartbeat.js";

function readVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // src/main.ts and dist/main.js both sit one level below the repo root.
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

async function main(): Promise<void> {
  const config = (() => {
    try {
      return loadConfig();
    } catch (err) {
      if (err instanceof ConfigError) {
        process.stderr.write(`config error: ${err.message}\n`);
        process.exit(2);
      }
      throw err;
    }
  })();

  const log = pino({ level: config.logLevel });
  const version = readVersion();
  const bootMs = Date.now();
  const instance = process.env.HOSTNAME ?? "local";

  let leader: Leader | null = null;
  const health = startHealthServer(
    () => ({
      configLoaded: true,
      leaderPolledOnce: leader?.polledOnce() ?? false,
    }),
    3000,
  );

  const state = createBeaconState();
  const rest = createRest({ apiBaseUrl: config.apiBaseUrl, key: config.beaconKey });

  let hub: HubClient | null = null;
  let socket: SocketLoop | null = null;
  let sendLoop: SendLoop | null = null;
  let heartbeat: HeartbeatLoop | null = null;
  let poller: Poller | null = null;

  function startCore() {
    if (socket) return;
    log.info("starting beacon core");
    socket = startSocketLoop({
      build: () => {
        hub = buildHubClient({ hubUrl: config.hubUrl, key: config.beaconKey });
        return hub;
      },
      ingestChannel: config.ingestChannel,
      key: config.beaconKey,
      state,
      onConnected: () => sendLoop?.wake(),
      onBuildError: (err) =>
        log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "hub build failed; backing off",
        ),
      log: {
        info: (fields, msg) => log.info(fields, msg),
        warn: (fields, msg) => log.warn(fields, msg),
      },
    });
    sendLoop = startSendLoop({
      state,
      rest,
      getHub: () => hub,
      ingestChannel: config.ingestChannel,
      onHubRejectionThreshold: () => {
        // Contracts 9.2: three consecutive hub rejections while the socket
        // stays connected ask the socket loop to re-join once.
        void socket?.rejoin();
      },
    });
    poller = createPoller({
      url: config.sourceUrl,
      pollMs: config.pollMs,
      state,
      onFix: () => sendLoop?.wake(),
    });
    poller.start();
    heartbeat = startHeartbeatLoop({
      state,
      rest,
      buildHealth: () =>
        buildHeartbeatHealth({ state, pollerStats: poller?.stats() ?? null }),
      buildDebug: () =>
        buildHeartbeatDebug({
          state,
          config,
          pollerStats: poller?.stats() ?? null,
          bootMs,
          version,
          instance,
          leader: leader?.isLeader() ?? false,
        }),
    });
  }

  async function stopCore() {
    if (!socket) return;
    log.info("stopping beacon core");
    poller?.stop();
    sendLoop?.stop();
    heartbeat?.stop();
    await socket.stop();
    socket = null;
    sendLoop = null;
    heartbeat = null;
    hub = null;
    poller = null;
  }

  leader = startLeader({
    gatewayInternalUrl: config.gatewayInternalUrl,
    realtimeToken: config.gatewayRealtimeToken,
    forceLeader: config.forceLeader,
    onChange: (isLeader) => {
      log.info({ isLeader }, "leader change");
      if (isLeader) startCore();
      else void stopCore();
    },
  });

  const shutdown = async (signal: string) => {
    log.info({ signal }, "shutdown");
    leader?.stop();
    await stopCore();
    await health.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
