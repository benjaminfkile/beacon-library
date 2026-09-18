# Beacon library: technical design

The beacon library is the one Node implementation of the beacon contract (contracts 9.2): the hub socket loop that reconnects forever, the send loop that prefers the hub and falls back to HTTP, the heartbeat loop, the REST client, and the leader monitor of contracts 7.5. Every Node beacon on the fleet is built on it. It exists so the reconnect behaviour is written, tested, and fixed in one place instead of being copied between repositories by hand.

Every name, shape, path, and rule below is the one in the shared contracts (`docs/contracts.md`); the contract wins on any difference. Choices this document makes are in section 9; choices that need the owner are in section 10.

---

## 1. Shape

| Piece | Choice |
|---|---|
| Runtime | Node 22, TypeScript strict, ES modules. One runtime dependency: `@microsoft/signalr` (WebSockets only, negotiation skipped). Native `fetch`. No logger dependency: the caller hands in a logger |
| Package | `beacon-library`, built to `dist/` with type declarations; one entry point, `beacon-library` |
| Distribution | A tarball from `npm pack`, attached to a GitHub release per version tag and vendored by each consumer (section 6) |
| Tests | Vitest: the socket loop, the send loop decision table, the heartbeat loop against the vendored heartbeat schema, the hub URL mapping, the leader monitor, the facade, and the conformance scenarios (section 5) |
| Repository | `beacon-library`, branches `grunt`, `dev`, `main`; `contracts/` vendored with `CONTRACTS_SHA` and a contracts check (contracts 13); `docs/DESIGN.md` and `docs/contracts.md` are byte-identical copies of the originals in `wmsfo-api/docs` |

```
beacon-library/
  package.json  tsconfig.json  tsconfig.build.json  vitest.config.ts
  .github/workflows/ci.yml  .github/workflows/release.yml
  CONTRACTS_SHA  contracts/  scripts/check-contracts.mjs
  docs/beacon-library.md  docs/DESIGN.md  docs/contracts.md  docs/README.md
  conformance/
    scenarios.json              the socket loop scenarios every beacon implementation must pass (section 5)
    scenarios.schema.json       the shape of that file
  src/
    index.ts                    the public surface (section 3)
    beacon.ts                   createBeacon and gateOnLeader: the facade (section 4)
    socketLoop.ts               connect, join, stay connected, reconnect forever (section 2)
    sendLoop.ts                 hub first, HTTP fallback, the re-join rule
    heartbeatLoop.ts            POST /beacons/heartbeat every 15 s
    rest.ts                     POST /locations, /beacons/heartbeat, GET /beacons/me
    hub.ts                      the SignalR client behind the HubClient interface
    state.ts                    BeaconState, the latest fix, the counters the heartbeat reports
    backoff.ts                  1 s, 2 s, 3 s, 5 s, then 5 s forever; 10 s after a denied join
    leader.ts                   GET /internal/leader poll (contracts 7.5), 90 s expiry
    testing.ts                  the fakes consumers' own tests use (a scripted HubClient, a recording Rest)
  tests/
```

---

## 2. The guarantee

A beacon reconnects its hub socket forever, for every reason a socket can end, and the only way out of the loop is an explicit `stop()`. The cases the fleet produces, all of which must end in `socket connected`:

| Case | What the loop sees |
|---|---|
| A gateway node dies, the fleet is refreshed, or the fleet scales down | the WebSocket closes with `1006`, with or without an error |
| The leader gateway node dies | the same close; the API's leadership moves on its own |
| The whole fleet is gone for a while | every connect attempt fails until it is back; the backoff repeats 5 s forever |
| The fleet scales up | nothing, or a close if the load balancer moves the connection |
| A half-open socket | the handshake or the join never settles; the close signal ends the wait at once |
| The gateway evicts the beacon (`auth_expired`) | a re-join on the same connection |
| The gateway evicts the beacon (any other reason) | a reconnect |
| The join is denied (the key was rotated or the hub was switched off for this beacon) | the first retry waits 10 s, then the normal backoff; the send loop carries fixes over HTTP meanwhile |
| The hub client cannot be built | logged, backed off, retried |

Every transition logs one INFO line through the caller's logger: `socket connected` with `{ channel, reconnectCount, attempt }`, `socket closed; reconnecting` with `{ channel, err, delayMs, attempt }` (`attempt` is the attempt that just ended, counted from 0), and the denied, evicted, and rejoined lines with the channel. A steady socket logs nothing. No line ever carries the beacon key.

---

## 3. Public surface

Everything is exported from the one entry point.

| Export | Use |
|---|---|
| `createBeacon`, `gateOnLeader` | the facade most beacons use (section 4) |
| `createBeaconState`, `setLatestFix`, `hasUndeliveredFix`, `BeaconState`, `LatestFix` | the state a beacon's fix source writes into |
| `createRest`, `Rest`, `LocationBody`, `HeartbeatBody`, `HealthCore`, `RestError` | the REST client, for a beacon that needs it directly |
| `startSocketLoop`, `startSendLoop`, `startHeartbeatLoop`, `buildHubClient`, `HubClient`, `decide` | the loops, for a beacon that wires them itself |
| `startLeader`, `Leader`, `LeaderOptions` | the leader monitor |
| `backoffMs`, `BACKOFF_MS`, `JOIN_DENIED_FIRST_WAIT_MS`, `HTTP_FALLBACK_INTERVAL_MS`, `HUB_REJECTION_REJOIN_THRESHOLD` | the constants of contracts 9.2 |
| `BeaconLogger` | `{ info, warn, error }`, each `(fields, msg)`; a pino logger satisfies it as is |
| `FakeHubClient`, `createFakeRest` (from `testing.ts`, exported from the entry point) | fakes for consumers' tests: a scripted hub and a recording REST client |

Semantic versioning: a change to anything in this table that breaks a caller is a major version.

---

## 4. The facade

Both Node beacons wire the same four things the same way: build the REST client, start the socket loop with a hub factory, start the send loop with the re-join callback, start the heartbeat loop; and tear them down in the reverse order when leadership is lost. `createBeacon` owns that wiring.

```ts
const beacon = createBeacon({
  apiBaseUrl, beaconKey, hubUrl, ingestChannel,
  log,                                    // BeaconLogger
  buildHealth: () => HealthCore,          // the three optional health leaves (contracts 4.2)
  buildDebug: () => Record<string, unknown>,   // the beacon's own debug object
});

beacon.state            // BeaconState: the fix source calls setLatestFix(beacon.state, fix) and beacon.wake()
beacon.wake()           // a new fix is ready
beacon.start()          // idempotent; logs "starting beacon core"
await beacon.stop()     // idempotent; send loop, heartbeat loop, then the socket; logs "stopping beacon core"
beacon.running()
beacon.rest             // the REST client, for GET /beacons/me at boot
```

`gateOnLeader({ leader: LeaderOptions, beacon, onStart?, onStop? })` starts the beacon when this node becomes leader and stops it when it stops being leader, calling `onStart` after the start and `onStop` before the stop so a beacon can start and stop its own fix source (a poller, a replay worker) with it. It returns the `Leader`, so the health probe can read `polledOnce()`.

A beacon that needs something the facade does not offer uses the loops directly; the facade is built only from the public surface.

---

## 5. Conformance scenarios

`conformance/scenarios.json` is the behaviour of section 2 written as data, so an implementation in another language can be held to the same cases. Red-Nose's Kotlin socket loop (red-nose.md 7.4) is the other implementation; the file is copied into that repository and run by its own test harness.

```json
{
  "schemaVersion": 1,
  "backoffMs": [1000, 2000, 3000, 5000],
  "joinDeniedFirstWaitMs": 10000,
  "scenarios": [
    {
      "name": "transport close while connected",
      "steps": [
        { "hub": "startResolves" },
        { "hub": "joinResolves" },
        { "expect": "connected", "reconnectCount": 1 },
        { "hub": "close", "error": "WebSocket closed with status code: 1006" },
        { "expect": "reconnecting", "delayMs": 1000 },
        { "advanceMs": 1000 },
        { "hub": "startResolves" },
        { "hub": "joinResolves" },
        { "expect": "connected", "reconnectCount": 2 }
      ]
    }
  ]
}
```

A step is one of: a scripted hub event (`startResolves`, `startRejects`, `startNeverSettles`, `joinResolves`, `joinDenied`, `joinRejects`, `joinNeverSettles`, `close` with an optional `error`, `evict` with a `reason`, `buildThrows`), a clock move (`advanceMs`), a caller action (`rejoin`, `stop`), or an expectation (`expect` with the socket state, and any of `reconnectCount`, `rejoinCount`, `delayMs`, `hubsBuilt`). The scenarios cover every row of the section 2 table, plus: a clean close with no error, a close during the handshake, a close during the join, 25 consecutive closes (25 reconnects, the backoff sequence, then 5 s repeating), and `stop()` during a backoff wait. `tests/conformance.test.ts` runs every scenario against `startSocketLoop` with fake timers and the scripted fake hub; a scenario the runner does not understand fails the run.

---

## 6. Distribution and versioning

- `VERSION` is `package.json`'s version. A release is a tag `v<version>` on `main`. `.github/workflows/release.yml` runs the checks, runs `npm pack`, and attaches `beacon-library-<version>.tgz` and its SHA-256 to a GitHub release of that tag.
- A consumer vendors the tarball: `vendor/beacon-library-<version>.tgz` committed in its repository, `"beacon-library": "file:vendor/beacon-library-<version>.tgz"` in its `package.json`, and `BEACON_LIBRARY_SHA` holding the library commit the tarball was packed from, the same way `contracts/` is vendored with `CONTRACTS_SHA`. Nothing fetches at install time, so CI, the container build, and a task runner without network access all install the same bytes, and the repositories can stay private.
- Updating a consumer: copy the new tarball in, delete the old one, change the dependency line and `BEACON_LIBRARY_SHA`, `npm install`, run the consumer's suite, deploy.
- `contracts/` here follows the API like every consumer: when contracts 9.2, 4.2, or 7.5 change, the library changes first, then its consumers.

---

## 7. Consumers

| Consumer | Uses |
|---|---|
| `legacy-beacon` | `createBeacon` and `gateOnLeader`; its own poller, normalizer, heartbeat health and debug builders, health probe, configuration |
| `simulator-beacon` | the same; its own worker, scheduler, flights cache, control API, database row |
| `red-nose` | none of the code (its beacon is a native Kotlin service); the conformance scenarios of section 5 |

A consumer keeps no copy of the core: no `src/beacon/`, no `src/leader.ts`, no tests of the library's behaviour. Its tests cover what it adds.

---

## 8. Tests and CI

`npm run contracts:check && npm run typecheck && npm test && npm run build`, in that order, in `ci.yml` on every push to `main`, `dev`, `grunt`, and `grunt-**`, and on pull requests; `release.yml` runs the same before it packs. The socket loop tests use fake timers and the scripted fake hub, never a real socket. A test that a packed tarball installs into an empty project and that `import { createBeacon } from "beacon-library"` type-checks and runs there is part of `release.yml`.

---

## 9. Decisions made here

- One library for the Node beacons and shared scenarios for the phone, because the phone's beacon is a native Kotlin service that cannot load TypeScript (2026-09-18).
- The legacy beacon's socket loop is the base: it is the later of the two and carries the handshake race, the close-reason logging, and the guard that ignores a close from a client the loop already replaced. Both repositories' socket loop suites run against it.
- `attempt` in the closed line is the attempt that just ended, counted from 0, as Red-Nose logs it.
- No logger dependency; the caller's logger is an argument.
- The library does not read environment variables and knows nothing about a beacon's configuration keys; `forceLeader` is an option the caller sets from its own key.
- Vendored tarballs instead of a registry: no tokens anywhere, the same bytes everywhere, private repositories.

## 10. Needs a decision

Nothing at the moment. Add here as it comes up.
