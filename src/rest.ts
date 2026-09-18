// The two HTTP calls the beacon makes: POST /locations (fallback while the
// socket is down) and POST /beacons/heartbeat (every 15 s, HTTP only). Both
// carry X-Beacon-Key and lift serverTime, code, and requestId out of the
// answer. tSend and tReceive are captured for the heartbeat's clock-skew
// calculation.

export interface RestOptions {
  apiBaseUrl: string;
  key: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}

export interface LocationBody {
  lat: number;
  lng: number;
  recordedAt: string;
  speedMps: number | null;
  altitudeM: number | null;
  headingDeg: number | null;
  accuracyM: number | null;
}

export interface HealthCore {
  batteryPercent?: number | null;
  lastFixAgeS?: number | null;
  socketState?: "connected" | "connecting" | "reconnecting" | "disconnected" | null;
}

export interface HeartbeatBody {
  sentAt: string;
  health?: HealthCore | null;
  debug?: Record<string, unknown> | null;
}

export interface LocationResponse {
  ok: true;
  status: number;
  seq: number;
  published: boolean;
  receivedAt: string;
  serverTime: string;
}

export interface HeartbeatResponse {
  ok: true;
  status: number;
  receivedAt: string;
  liveEventId: number | null;
  isActive: boolean;
  serverTime: string;
  tSendMs: number;
  tReceiveMs: number;
}

export interface RestError {
  ok: false;
  status: number | null;
  code: string | null;
  message: string | null;
  requestId: string | null;
  serverTime: string | null;
  transportError?: string;
}

async function callJson(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ res: Response | null; body: unknown; transportError?: string }> {
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { ...init, signal: controller.signal });
    let body: unknown = null;
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      try {
        body = await res.json();
      } catch {
        body = null;
      }
    }
    return { res, body };
  } catch (err) {
    return {
      res: null,
      body: null,
      transportError: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(to);
  }
}

function readErrorFields(body: unknown): {
  code: string | null;
  message: string | null;
  requestId: string | null;
} {
  if (!body || typeof body !== "object")
    return { code: null, message: null, requestId: null };
  const b = body as Record<string, unknown>;
  return {
    code: typeof b.code === "string" ? b.code : null,
    message: typeof b.message === "string" ? b.message : null,
    requestId: typeof b.requestId === "string" ? b.requestId : null,
  };
}

function readServerTime(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  return typeof b.serverTime === "string" ? b.serverTime : null;
}

export function createRest(opts: RestOptions) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const now = opts.now ?? (() => Date.now());
  const base = opts.apiBaseUrl.replace(/\/$/, "");

  async function postLocation(body: LocationBody): Promise<LocationResponse | RestError> {
    const { res, body: resBody, transportError } = await callJson(
      fetchImpl,
      `${base}/locations`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Beacon-Key": opts.key,
        },
        body: JSON.stringify(body),
      },
      timeoutMs,
    );
    if (!res) {
      return {
        ok: false,
        status: null,
        code: null,
        message: null,
        requestId: null,
        serverTime: null,
        transportError,
      };
    }
    if (!res.ok) {
      const e = readErrorFields(resBody);
      return {
        ok: false,
        status: res.status,
        code: e.code,
        message: e.message,
        requestId: e.requestId,
        serverTime: readServerTime(resBody),
      };
    }
    const b = (resBody ?? {}) as Record<string, unknown>;
    return {
      ok: true,
      status: res.status,
      seq: typeof b.seq === "number" ? b.seq : 0,
      published: b.published === true,
      receivedAt: typeof b.receivedAt === "string" ? b.receivedAt : "",
      serverTime: typeof b.serverTime === "string" ? b.serverTime : "",
    };
  }

  async function postHeartbeat(body: HeartbeatBody): Promise<HeartbeatResponse | RestError> {
    const tSend = now();
    const { res, body: resBody, transportError } = await callJson(
      fetchImpl,
      `${base}/beacons/heartbeat`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Beacon-Key": opts.key,
        },
        body: JSON.stringify(body),
      },
      timeoutMs,
    );
    const tReceive = now();
    if (!res) {
      return {
        ok: false,
        status: null,
        code: null,
        message: null,
        requestId: null,
        serverTime: null,
        transportError,
      };
    }
    if (!res.ok) {
      const e = readErrorFields(resBody);
      return {
        ok: false,
        status: res.status,
        code: e.code,
        message: e.message,
        requestId: e.requestId,
        serverTime: readServerTime(resBody),
      };
    }
    const b = (resBody ?? {}) as Record<string, unknown>;
    return {
      ok: true,
      status: res.status,
      receivedAt: typeof b.receivedAt === "string" ? b.receivedAt : "",
      liveEventId:
        typeof b.liveEventId === "number"
          ? b.liveEventId
          : b.liveEventId === null
            ? null
            : null,
      isActive: b.isActive === true,
      serverTime: typeof b.serverTime === "string" ? b.serverTime : "",
      tSendMs: tSend,
      tReceiveMs: tReceive,
    };
  }

  return { postLocation, postHeartbeat };
}

export type Rest = ReturnType<typeof createRest>;
