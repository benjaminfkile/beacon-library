// Beacon core state per contracts 9.2. One LatestFix, one Telemetry value, the
// last heartbeat answer, transport counters, and the socket state.

export type SocketState = "connected" | "connecting" | "reconnecting" | "disconnected";

export interface LatestFix {
  lat: number;
  lng: number;
  recordedAt: string;
  speedMps: number | null;
  altitudeM: number | null;
  headingDeg: number | null;
  accuracyM: number | null;
  seqLocal: number;
}

export interface LastHeartbeat {
  receivedAt: string;
  liveEventId: number | null;
  isActive: boolean | null;
}

export interface BeaconState {
  socketState: SocketState;
  latestFix: LatestFix | null;
  lastDeliveredSeqLocal: number;
  reconnectCount: number;
  rejoinCount: number;
  sendsFailedSinceBoot: number;
  lastReceiptLatencyMs: number | null;
  httpFallbackSeconds: number;
  lastHeartbeat: LastHeartbeat | null;
  clockSkewMs: number | null;
  revoked: boolean;
  nextSeqLocal: number;
}

export function createBeaconState(): BeaconState {
  return {
    socketState: "disconnected",
    latestFix: null,
    lastDeliveredSeqLocal: 0,
    reconnectCount: 0,
    rejoinCount: 0,
    sendsFailedSinceBoot: 0,
    lastReceiptLatencyMs: null,
    httpFallbackSeconds: 0,
    lastHeartbeat: null,
    clockSkewMs: null,
    revoked: false,
    nextSeqLocal: 1,
  };
}

export function setLatestFix(
  s: BeaconState,
  f: Omit<LatestFix, "seqLocal">,
): LatestFix {
  const next: LatestFix = { ...f, seqLocal: s.nextSeqLocal++ };
  s.latestFix = next;
  return next;
}

export function hasUndeliveredFix(s: BeaconState): boolean {
  return s.latestFix !== null && s.latestFix.seqLocal !== s.lastDeliveredSeqLocal;
}
