// The facade the beacons on the fleet use (docs/beacon-library.md section 4).
// Wires the socket loop, the send loop, and the heartbeat loop together the
// way the two reference beacons wire them by hand; runs on the leader through
// gateOnLeader when a beacon wants leadership gating.

import { buildHubClient, type HubClient, type HubOptions } from "./hub.js";
import { startHeartbeatLoop, type HeartbeatLoop } from "./heartbeatLoop.js";
import { startLeader, type Leader, type LeaderOptions } from "./leader.js";
import type { BeaconLogger } from "./logger.js";
import { createRest, type HealthCore, type Rest } from "./rest.js";
import { startSendLoop, type SendLoop } from "./sendLoop.js";
import { startSocketLoop, type SocketLoop } from "./socketLoop.js";
import { createBeaconState, type BeaconState } from "./state.js";

export interface CreateBeaconOptions {
  apiBaseUrl: string;
  beaconKey: string;
  hubUrl: string;
  ingestChannel: string;
  log: BeaconLogger;
  buildHealth: () => HealthCore;
  buildDebug: () => Record<string, unknown>;
  buildHub?: (o: HubOptions) => HubClient;
  fetchImpl?: typeof fetch;
}

export interface Beacon {
  state: BeaconState;
  rest: Rest;
  start(): void;
  stop(): Promise<void>;
  wake(): void;
  running(): boolean;
}

export function createBeacon(opts: CreateBeaconOptions): Beacon {
  const state = createBeaconState();
  const rest = createRest({
    apiBaseUrl: opts.apiBaseUrl,
    key: opts.beaconKey,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  const buildHub = opts.buildHub ?? buildHubClient;
  const log = opts.log;

  let socket: SocketLoop | null = null;
  let sendLoop: SendLoop | null = null;
  let heartbeat: HeartbeatLoop | null = null;
  let hub: HubClient | null = null;

  function start(): void {
    if (socket) return;
    log.info({}, "starting beacon core");
    socket = startSocketLoop({
      build: () => {
        hub = buildHub({ hubUrl: opts.hubUrl, key: opts.beaconKey });
        return hub;
      },
      ingestChannel: opts.ingestChannel,
      key: opts.beaconKey,
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
      ingestChannel: opts.ingestChannel,
      onHubRejectionThreshold: () => {
        void socket?.rejoin();
      },
    });
    heartbeat = startHeartbeatLoop({
      state,
      rest,
      buildHealth: opts.buildHealth,
      buildDebug: opts.buildDebug,
    });
  }

  async function stop(): Promise<void> {
    if (!socket) return;
    log.info({}, "stopping beacon core");
    sendLoop?.stop();
    heartbeat?.stop();
    const s = socket;
    socket = null;
    sendLoop = null;
    heartbeat = null;
    await s.stop();
    hub = null;
  }

  return {
    state,
    rest,
    start,
    stop,
    wake() {
      sendLoop?.wake();
    },
    running() {
      return socket !== null;
    },
  };
}

export interface GateOnLeaderOptions {
  leader: Omit<LeaderOptions, "onChange">;
  beacon: Beacon;
  onStart?: () => void | Promise<void>;
  onStop?: () => void | Promise<void>;
  log: BeaconLogger;
}

export function gateOnLeader(opts: GateOnLeaderOptions): Leader {
  let chain: Promise<void> = Promise.resolve();
  const log = opts.log;
  const beacon = opts.beacon;

  return startLeader({
    ...opts.leader,
    onChange: (isLeader) => {
      chain = chain.then(async () => {
        log.info({ isLeader }, "leader change");
        if (isLeader) {
          beacon.start();
          if (opts.onStart) {
            try {
              await opts.onStart();
            } catch (err) {
              log.error(
                { err: err instanceof Error ? err.message : String(err) },
                "onStart failed",
              );
            }
          }
        } else {
          if (opts.onStop) {
            try {
              await opts.onStop();
            } catch (err) {
              log.error(
                { err: err instanceof Error ? err.message : String(err) },
                "onStop failed",
              );
            }
          }
          await beacon.stop();
        }
      });
    },
  });
}
