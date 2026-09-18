import { describe, expect, it } from "vitest";
import { startLeader } from "../src/leader.js";

function makeFetch(entries: Array<Response | Error>): typeof fetch {
  let i = 0;
  return (async () => {
    const next = entries[i++];
    if (!next) throw new Error(`no scripted response ${i - 1}`);
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("leader poll (contracts 7.5)", () => {
  it("leader on 2xx + isLeader + fresh evaluatedAt", async () => {
    const now = () => 100_000;
    const leader = startLeader({
      gatewayInternalUrl: "http://gateway:8080",
      realtimeToken: "grt_x",
      pollMs: 60_000,
      now,
      autoStart: false,
      fetchImpl: makeFetch([
        jsonResponse({
          isLeader: true,
          evaluatedAt: new Date(now() - 30_000).toISOString(),
        }),
      ]),
    });
    await leader.pollOnce();
    expect(leader.isLeader()).toBe(true);
    expect(leader.polledOnce()).toBe(true);
    leader.stop();
  });

  it("follower on evaluatedAt older than 90 s", async () => {
    const now = () => 500_000;
    const leader = startLeader({
      gatewayInternalUrl: "http://gateway:8080",
      realtimeToken: "grt_x",
      pollMs: 60_000,
      now,
      autoStart: false,
      fetchImpl: makeFetch([
        jsonResponse({
          isLeader: true,
          evaluatedAt: new Date(now() - 91_000).toISOString(),
        }),
      ]),
    });
    await leader.pollOnce();
    expect(leader.isLeader()).toBe(false);
    leader.stop();
  });

  it("follower on any failure (network, non-2xx, null evaluatedAt)", async () => {
    for (const scripted of [
      new Error("net"),
      jsonResponse({}, 502),
      jsonResponse({ isLeader: true, evaluatedAt: null }),
    ]) {
      const leader = startLeader({
        gatewayInternalUrl: "http://gateway:8080",
        realtimeToken: "grt_x",
        pollMs: 60_000,
        autoStart: false,
        fetchImpl: makeFetch([scripted]),
      });
      await leader.pollOnce();
      expect(leader.isLeader()).toBe(false);
      leader.stop();
    }
  });

  it("LB_FORCE_LEADER=true makes the node leader without a gateway", async () => {
    const leader = startLeader({
      gatewayInternalUrl: "http://unused",
      realtimeToken: null,
      forceLeader: true,
      pollMs: 60_000,
      autoStart: false,
      fetchImpl: (async () => {
        throw new Error("must not fetch");
      }) as typeof fetch,
    });
    await leader.pollOnce();
    expect(leader.isLeader()).toBe(true);
    leader.stop();
  });
});
