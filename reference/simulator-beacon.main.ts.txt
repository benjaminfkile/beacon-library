// Boot: load config, connect to the database and create the sim_run row when
// missing, start the fastify server (health + control API), start the leader
// poll, run the beacon core and the worker loop on the leader.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pino, { type Logger } from "pino";
import { loadConfig, ConfigError, type Config } from "./config.js";
import { createDb, type Db } from "./db.js";
import { startLeader, type Leader } from "./leader.js";
import {
  createBeaconState,
  setLatestFix,
  type BeaconState,
} from "./beacon/state.js";
import { createRest } from "./beacon/rest.js";
import { buildHubClient, type HubClient } from "./beacon/hub.js";
import { startSocketLoop, type SocketLoop } from "./beacon/socketLoop.js";
import { startSendLoop, type SendLoop } from "./beacon/sendLoop.js";
import { startHeartbeatLoop, type HeartbeatLoop } from "./beacon/heartbeatLoop.js";
import { createFlightsApi } from "./flights/api.js";
import { createFlightsCache, type FlightsCache } from "./flights/cache.js";
import { createAdminAuth } from "./control/auth.js";
import { buildControlServer } from "./control/routes.js";
import { startWorker, type WorkerHandle } from "./worker.js";

function readVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

interface Core {
  socket: SocketLoop;
  sendLoop: SendLoop;
  heartbeat: HeartbeatLoop;
  getHub: () => HubClient | null;
  clearHub: () => void;
}

function startCore(args: {
  config: Config;
  state: BeaconState;
  bootMs: number;
  version: string;
  instance: string;
  isLeader: () => boolean;
  getWorker: () => WorkerHandle | null;
  cache: FlightsCache;
  log: Logger;
}): Core {
  const { config, state, bootMs, version, instance, isLeader, getWorker, cache, log } = args;
  const rest = createRest({ apiBaseUrl: config.apiBaseUrl, key: config.beaconKey });
  let hub: HubClient | null = null;

  const socket = startSocketLoop({
    build: () => {
      hub = buildHubClient({ hubUrl: config.hubUrl, key: config.beaconKey });
      return hub;
    },
    ingestChannel: config.ingestChannel,
    key: config.beaconKey,
    state,
    onConnected: () => sendLoop.wake(),
    onBuildError: (err) =>
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "hub build failed; backing off",
      ),
    log: {
      info: (obj, msg) => log.info(obj, msg),
      warn: (obj, msg) => log.warn(obj, msg),
    },
  });

  const sendLoop = startSendLoop({
    state,
    rest,
    getHub: () => hub,
    ingestChannel: config.ingestChannel,
    onHubRejectionThreshold: () => {
      // Contracts 9.2: three consecutive hub rejections while `socketState`
      // stays `connected` ask the socket loop to re-join once. The rejoin
      // itself increments `rejoinCount` and takes the failure branch on throw.
      void socket.rejoin();
    },
  });

  const heartbeat = startHeartbeatLoop({
    state,
    rest,
    buildHealth: () => {
      const lastFixAgeS = state.latestFix
        ? Math.max(0, Math.floor((Date.now() - Date.parse(state.latestFix.recordedAt)) / 1000))
        : null;
      return {
        batteryPercent: null,
        lastFixAgeS,
        socketState: state.socketState,
      };
    },
    buildDebug: () => {
      const worker = getWorker();
      const lastLoad = cache.lastLoad();
      const status = worker?.runningStatus() ?? null;
      return {
        run: worker
          ? {
              status,
              index: worker.currentIndex(),
              total: worker.currentTotal(),
              nextFixInMs: worker.nextFixInMs(),
            }
          : null,
        source: {
          apiBaseUrl: config.apiBaseUrl,
          cachedYears: cache.cachedYears(),
          lastFlightLoadMs: lastLoad.ms,
          lastFlightLoadAt: lastLoad.at,
        },
        transport: {
          socketState: state.socketState,
          reconnectCount: state.reconnectCount,
          rejoinCount: state.rejoinCount,
          httpFallbackSeconds: state.httpFallbackSeconds,
          lastReceiptLatencyMs: state.lastReceiptLatencyMs,
          sendsFailedSinceBoot: state.sendsFailedSinceBoot,
        },
        process: {
          uptimeS: Math.max(0, Math.floor((Date.now() - bootMs) / 1000)),
          leader: isLeader(),
          instance,
          version,
          node: process.version,
        },
      };
    },
  });

  return {
    socket,
    sendLoop,
    heartbeat,
    getHub: () => hub,
    clearHub: () => {
      hub = null;
    },
  };
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

  // A beacon never gives up: an unhandled rejection or a synchronous throw
  // that escapes anything in the loops is logged at error and swallowed so
  // the process keeps running (simulator-beacon.md 2, contracts 9.2).
  process.on("unhandledRejection", (reason) => {
    log.error(
      {
        err: reason instanceof Error ? reason.message : String(reason),
        stack: reason instanceof Error ? reason.stack : undefined,
      },
      "unhandledRejection",
    );
  });
  process.on("uncaughtException", (err) => {
    log.error(
      { err: err.message, stack: err.stack },
      "uncaughtException",
    );
  });

  const db: Db = createDb({ connectionString: config.dbConnection });
  await db.init();

  const flightsApi = createFlightsApi({
    apiBaseUrl: config.apiBaseUrl,
    apiKey: config.apiKey,
  });
  const cache = createFlightsCache({ api: flightsApi });
  // Kick off the initial flight-cache refresh in the background so
  // `GET /control/years` has real `pointCount` values from the first request
  // (simulator-beacon.md 4). Errors are logged; `listYears()` will retry on
  // its own schedule.
  void cache.refresh().catch((err) =>
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "initial flight cache refresh failed",
    ),
  );

  const auth = createAdminAuth({
    issuer: config.cognitoIssuer,
    audiences: config.cognitoClientIds,
    adminGroup: config.adminGroup,
  });

  let leader: Leader | null = null;
  const state = createBeaconState();
  let core: Core | null = null;
  let worker: WorkerHandle | null = null;

  const server = await buildControlServer({
    db,
    cache,
    auth,
    corsOrigins: config.corsOrigins,
    probe: () => ({
      configLoaded: true,
      leaderPolledOnce: leader?.polledOnce() ?? false,
      isLeader: leader?.isLeader() ?? false,
    }),
    buildBeaconState: () => beaconLeaderState(),
    instance,
  });

  await server.listen({ port: 3000, host: "0.0.0.0" });

  function beaconLeaderState(): Record<string, unknown> {
    const hb = state.lastHeartbeat;
    const heartbeatAge = hb?.receivedAt
      ? Math.max(0, Math.floor((Date.now() - Date.parse(hb.receivedAt)) / 1000))
      : null;
    return {
      name: "simulator",
      isActive: hb?.isActive ?? null,
      liveEventId: hb?.liveEventId ?? null,
      socketState: state.socketState,
      lastDeliveredSeqLocal: state.lastDeliveredSeqLocal,
      lastReceiptLatencyMs: state.lastReceiptLatencyMs,
      heartbeatAge,
      revoked: state.revoked,
    };
  }

  function startCoreOnce() {
    if (core) return;
    log.info("starting beacon core");
    core = startCore({
      config,
      state,
      bootMs,
      version,
      instance,
      isLeader: () => leader?.isLeader() ?? false,
      getWorker: () => worker,
      cache,
      log,
    });
  }

  function startWorkerOnce() {
    if (worker) return;
    log.info("starting worker");
    worker = startWorker({
      db,
      cache,
      buildLeaderState: () => beaconLeaderState(),
      onEmit: ({ point, recordedAtNow }) => {
        setLatestFix(state, {
          lat: point.lat,
          lng: point.lng,
          recordedAt: recordedAtNow,
          speedMps: point.speedMps,
          altitudeM: point.altitudeM,
          headingDeg: point.headingDeg,
          accuracyM: point.accuracyM,
        });
        core?.sendLoop.wake();
      },
      onStop: () => undefined,
      log: {
        error: (obj, msg) => log.error(obj, msg),
      },
    });
  }

  async function stopCoreOnce() {
    if (!core) return;
    log.info("stopping beacon core");
    core.sendLoop.stop();
    core.heartbeat.stop();
    await core.socket.stop();
    core.clearHub();
    core = null;
  }

  async function stopWorkerOnce() {
    if (!worker) return;
    log.info("stopping worker");
    await worker.stop();
    worker = null;
  }

  leader = startLeader({
    gatewayInternalUrl: config.gatewayInternalUrl,
    realtimeToken: config.gatewayRealtimeToken,
    forceLeader: config.forceLeader,
    onChange: (isLeader) => {
      log.info({ isLeader }, "leader change");
      if (isLeader) {
        startCoreOnce();
        startWorkerOnce();
      } else {
        void stopCoreOnce();
        void stopWorkerOnce();
      }
    },
  });

  const shutdown = async (signal: string) => {
    log.info({ signal }, "shutdown");
    leader?.stop();
    await stopCoreOnce();
    await stopWorkerOnce();
    await server.close();
    await db.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
