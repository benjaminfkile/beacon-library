# WMSFO v2 design (draft 1)

Working notes, not a spec. Anything here can change until the schema is cut.

The technical designs that make this exact live in each repository's `docs/` folder. `wmsfo-api/docs` holds the originals of this file and `contracts.md` (the shared interfaces every component codes against) plus `api.md`, `sql.md`, `platform.md`, and `reference/legacy-schema.md`; `santa/docs` holds `site.md`, `wmsfo-admin-panel/docs` holds `admin.md`, and `red-nose/docs` holds `red-nose.md`. Those three repositories carry byte-identical copies of `DESIGN.md` and `contracts.md` so an agent working in one of them has the whole picture in-repo; edit the originals in `wmsfo-api` and recopy. Each document ends with "Decisions made here" (choices to veto) and "Needs a decision" (choices only the owner can make).

## 1. Why rebuild

- The API's job is small: take location updates from trusted beacons and hand them to the public site fast. Everything else on top of that (modes, Heroku polling, fleet broadcasts, UUID route prefixes) is scar tissue.
- Events become real records with a status, not a number inferred from a phone app.
- People can opt in to alerts and to a bit of fun (cookies) without the site ever depending on accounts.

## 2. Pieces

| Piece | Status | Notes |
|---|---|---|
| Public site | full rewrite, Vite + React + TypeScript SPA on Vercel (§6c) | renders admin-composed pages from the snapshot (§6d); reads only the CDN and the hub; never calls the API for reads |
| Admin panel | keep, moved from Create React App to Vite | Cognito MFA login; event, beacon, sponsor, and settings management; pages, sections, media, icons, site settings, publish and versions, preview (§6d) |
| API (C#) | new | ASP.NET Core minimal API, .NET 10, EF Core + Npgsql, runs behind the gateway as `wmsfo-api` |
| Realtime | gateway hub | public channel for the site, private channel for beacons, publish from the container |
| Data | new Postgres schema | legacy rows migrated once; content (pages, sections, media) lives here too and publishes into the snapshot |
| Simulator beacon | new, Node and TypeScript, on the fleet behind the gateway, control page on Vercel | an enrolled beacon that replays a past year's flight at a chosen speed; its control page signs in through the admin pool; reads flights through an API key with the `events` capability |
| Legacy beacon | new, Node and TypeScript, on the fleet behind the gateway | an enrolled beacon that polls the legacy Heroku tracker once a second and posts what it reports, normalized; no user interface |
| Alerts | SES email only (year one) | opt in, double opt in, unsubscribe link in every message; SMS numbers kept in §6 for later |
| Auth | two Cognito pools per environment: a people pool (`wmsfo-dev`, `wmsfo-prod`) and an admin pool (`wmsfo-admin-dev`, `wmsfo-admin-prod`) | people self sign up in the people pool; admins and editors are operator-created in the admin pool as groups with MFA enforced; a role counts only on an admin-pool token |

Names stay: manifest service `wmsfo-api` / `wmsfo-api-dev`, same domain rewrite, same repo names. The current repos get renamed `<name>-legacy` first.

The API never calls Heroku, never polls anything, never asks who its peers are. Location comes to it.

## 3. Events are the state

```
event_status (lookup)   1 planned, 2 scheduled, 3 live, 4 ended, 5 cancelled
event                   id, year, name, status_id, scheduled_at, went_live_at, ended_at, funds_percent, route_id, route_image_media_id, updated_at
route                   id, name, s3_key, url, point_count, uploaded_by, created_at
event_message           id, event_id, body, event_time, created_at   (the "event updates" of today)
```

- Exactly one event may be `live` at a time (partial unique index on `status_id = live`).
- Status changes happen in one transaction: row update + `event_status_history` row + snapshot rebuild and new URL + an outbox row. The publisher (see §8) turns the outbox into alert fan-out; the node cache picks the change up through the version (§4) and the node republishes the live object (CDN + hub) carrying the new `eventStatusId`.
- The site derives everything from `eventStatusId` on the location payload: one screen per status, named after the status (planned, scheduled, live, ended, cancelled). No mode field anywhere, and no grouping of statuses into shared layouts.
- Anything time-shaped (countdown, liftoff timer) reads from `scheduled_at` / `went_live_at`.
- Status changes only when an admin changes it. Nothing infers, schedules, or auto-flips a status. Going live needs a healthy active beacon: one the API has heard from within the stale window (a heartbeat or a fix; the socket is not required). The API refuses otherwise and the panel says why.

## 4. Location pipeline

**Beacons** are devices or people the admin trusts (the Red-Nose app in §6b, or anything else that holds a key). Registration:

1. Admin creates a beacon in the panel (name, notes). The API mints a key, shows it once, and can render it as a QR code.
2. The QR encodes an enrollment URL with a one-time token; scanning it on the device exchanges the token for the key and stores it. Typing the key by hand works too.
3. Keys are stored hashed. Admin can revoke, rotate, and see `last_seen_at`.

**Ingest** of locations, two doors, same payload, same validation, websocket preferred:

- Hub: the beacon joins private channel `wmsfo-api:ingest` presenting its key as the credential, then `SendToChannel("wmsfo-api:ingest", "location", payload)`. The gateway forwards it to the API's `realtime_message_path`; the API stores it and answers 2xx, which is the beacon's receipt.
- `POST /locations` with header `X-Beacon-Key`, used while the socket is down.

Payload the API expects (everything else is rejected with a 400 that says why):

```json
{ "lat": 46.87, "lng": -114.0, "recordedAt": "2026-12-22T01:31:07Z",
  "speedMps": 31.2, "altitudeM": 1210, "headingDeg": 84, "accuracyM": 6 }
```

**Telemetry** rides separately: the beacon sends a heartbeat (`POST /beacons/heartbeat`, HTTP only, the socket carries locations only) every 15 s whether or not it has a fix, so the admin sees a healthy beacon on the ground before liftoff. It lands on the beacon row (`last_heartbeat_at`, `telemetry jsonb`) and is never published to the site. The API knows nothing about what a beacon is: a heartbeat is `sentAt`, a tiny optional `health` core the panel colours (battery percent, age of the last fix, socket state), and a free-form `debug` object the beacon fills with whatever it wants the admin to see. The panel renders `debug` as a themed JSON tree and never interprets it. Red-Nose puts its whole telemetry set there (power, radio, GPS, transport, process, identity, clock skew); the simulator and the legacy beacon put their own. Skew is telemetry only; it never affects what fans out.

The admin panel's beacon page renders this live and colours the three health values out of range (battery under 20 %, no fix for 30 s, socket down) plus the API's own stamps (stale, heartbeat old). Telemetry is also the first thing debug mode shows on the phone itself.

Server stamps `received_at`, `beacon_id`, `event_id` (the live event), `seq` (arrival order, the only order that exists). No live event means 409, the update is not stored. `recordedAt` is informational: stored and shown, it never decides anything. The latest update received from the active beacon is Santa's location, whatever its timestamp says, and it fans out the moment it is stored.

**Delivery** to the public site: the CDN for polling, the hub for the fast path. The API has no public read endpoint at all.

The live object, the same bytes on both paths:

```json
{ "eventId": 7, "eventStatusId": 3, "pollIntervalMs": 5000,
  "snapshotUrl": "https://<cdn>/snapshots/3f9a….json",
  "cookieTally": { "1": 412, "3": 90 },
  "seq": 1832, "lat": 46.87, "lng": -114.0, "speedMps": 31.2, "altitudeM": 1210,
  "headingDeg": 84, "accuracyM": 6, "recordedAt": "…", "receivedAt": "…" }
```

- **Polling is CDN only.** On every stored update from the active beacon, and on every snapshot change, the node that took it writes the live object to one fixed key, `live/location.json`, with `Cache-Control: s-maxage=1, max-age=0`. The site polls that URL at `pollIntervalMs`. CloudFront collapses concurrent misses and, with Origin Shield on, the whole world costs S3 about one read per second. S3 is strongly consistent, so the object is readable the instant the PUT returns; worst-case staleness is the poll interval plus about 1.5 s. This is the live-video playlist pattern and it scales to any crowd without touching the fleet. At 100k pollers every 5 s for two hours the CloudFront bill is on the order of $150.
- **Hub channel `wmsfo-api:location`** carries the same object as the fast path, published after every write of the live object. This is what the fleet is for: it gets scaled up to 10 or more large instances before the event, and more if needed. The hub's cost is memory per connection and fan-out per message, both linear in instances, so the pre-event scale-up is the capacity plan.
- **The snapshot is a file on the CDN**, not an endpoint. It holds everything the site needs beyond the live point: the current event (id, year, name, status id, scheduled time, latest message), sponsors, funds percent, cookie types, `routeUrl`, the published content document (pages, sections, site settings, §6d), and the media map. Every admin write that touches any of it, and every content publish, rebuilds the snapshot JSON, writes it to the bucket under a content-hashed key (`snapshots/{sha256}.json`, one-year immutable cache header), and commits the new URL to the single-row `snapshot` table in the same transaction as the write (S3 first, then commit; if S3 fails the admin's write fails). A change is therefore just a new URL. No invalidation, ever, and the API never serves sponsor or event bytes to the public.

How the site uses it: load, fetch `live/location.json` from the CDN, fetch `snapshotUrl` from the CDN, render. Then join the hub channel and keep polling the CDN at `pollIntervalMs` as the floor, tightened when hub events stop. `eventStatusId` is the switch: each status renders its own screen, and live is the map. When `snapshotUrl` changes, fetch the new one; that is how a new sponsor, a new message, or a funds update reaches every browser with the API serving nothing to the public.

**Node cache and reconcile loop.** Each node keeps the live object in memory. Its reconcile loop, on a short tick like the gateway's, reads the single-row `snapshot` table (url, version) and the live event's id and status, and refreshes its copy when the version moved. Location writes go straight into memory on arrival (and to SQL for the record), then to `live/location.json` and the hub. The cookie tally is a handful of counters kept in memory, incremented on write and re-read by the loop. The node that took an admin write refreshes immediately and republishes the live object so the status change reaches the CDN and the hub without waiting for a location update.

**The route the public sees is a poster.** The route page shows a high-resolution image of the planned route (the same kind of poster the old site showed) in a deep-zoom viewer with pan, zoom, and fullscreen, with a disclaimer that the plan changes on the night. The admin uploads it through the media library and links it to the event; at upload the API cuts a Deep Zoom tile pyramid beside the asset on the CDN, the snapshot carries the media id, and the viewer (OpenSeadragon, as on the legacy site) streams the tiles it needs at the zoom it is at, so a phone never downloads the whole poster. A new poster is a new asset with new URLs, so nothing is ever cached stale. Nothing draws planned points on a map.

**Flight history rides in the snapshot.** A route JSON (`routes/{sha256}.json`, a `route` row linked from the event) is a recording of a flight: built from an event's stored locations, or uploaded. Red-Nose's replay mode, admin exports, and the end-to-end tests read it from the CDN. The tracker reads it from the snapshot: the recording linked to the current event is embedded as `event.flightHistory`, thinned to an admin-set point cap, so the first snapshot a browser fetches carries it and the "flight history" toggle draws it as a projected route with no second request. The admin links a different recording to the event at any time and the next snapshot carries that one. The tracker never draws where Santa has been; it shows only where he is. A new event inherits the recording of the most recent event that had one.

Recorded locations stay in the database for the record and are available to an admin as an export (`GET /events/{id}/locations`, admin only). Nothing on the public site reads them.

One beacon is **active** at a time, marked by the admin in the panel. Only its updates fan out and become the current location. Other enrolled beacons may send too (a spare phone being tested during the event); their updates are stored with their beacon id but never published, so testing a spare can never move Santa. Switching the active beacon is one click and takes effect on the next update.

## 5. Who can do what

| Actor | How | Can |
|---|---|---|
| Anyone | nothing | read the site, current event, sponsors, route poster, leave a contact message |
| Beacon | key (header or hub credential) | post locations, heartbeats with its own debug data, and log files; every beacon is the same to the API, whatever runs behind the key |
| Script or agent | API key minted by an admin, with every capability or a chosen subset and an optional expiry | whatever its capabilities allow across the admin surface; never mint, list, or revoke keys |
| Registered person | the env's Cognito pool, no MFA, email as username | manage alerts, leave cookies |
| Editor | the env's admin pool, group `editor`, MFA enforced | pages, sections, media, icons, site settings, publish and versions, preview, sponsors |
| Admin | the env's admin pool, group `admin`, MFA enforced | everything an editor can, plus events, routes, beacons, cookie types, cookie moderation, settings, subscribers, people, contact messages, diagnostics |

Rules that never bend: every public page works logged out; sign-up is a small link, never a wall or a nag; admin, beacon, and API-key credentials are never the same thing.

## 6. Optional accounts

**Alerts.** Email only for year one. `subscriber` (person_id, channel, address, verified_at, unsubscribed_at) keeps a `channel` column so SMS can be added without a schema change. Subscribe means: verify the address once, then receive an email when an event is scheduled, goes live, or posts an update. Every email has a one-click unsubscribe link. Send fan-out runs as a leader chore off the outbox so a fleet of two never double sends.

Cost reference at the scale we are planning for (100k visitors, 20k accounts, 3 messages each, 60k sends). Email is the only row that applies this year:

| Channel | Per send | 60k sends | Fixed | Catch |
|---|---|---|---|---|
| Email (SES) | $0.0001 | about $6 | none | domain verification, leave the sandbox |
| SMS, 10DLC | about $0.009 to $0.013 per segment | $540 to $780 | $4.50 brand, $41.50 vetting, $10/mo campaign, $1/mo number | 160 chars per segment, registration takes weeks, T-Mobile daily cap depends on vetting tier |
| SMS, toll-free | $0.013 per segment | about $770 | $2/mo | 3 messages per second by default, so 20k texts take almost 2 hours |

If SMS ever comes back: 10DLC registration takes weeks, an unvetted brand is capped at 2,000 texts a day to T-Mobile customers, and a toll-free number sends 3 a second. Plan a full quarter ahead.

**Cookies.** Registered people leave digital cookies during a live event. A cookie is a type plus an optional note; no location, and no idea of Santa eating anything anywhere in the UI.

```
cookie_type       id, name, icon, sort, active             (chocolate chip, gingerbread, snickerdoodle, sugar, happy, sponsor specials)
cookie            id, event_id, person_id, cookie_type_id, note, left_at
```

- The public site shows one thing: the cookie leaderboard, every type with its count, sorted most to least popular. It is on the live screen and stays on the ended screen afterwards. The tally rides on the live object as `cookieTally` (a few numbers), kept in each node's memory and refreshed by the reconcile loop, so the leaderboard needs no endpoint of its own; the live object written on the transition to `ended` carries the final counts and nothing overwrites it after that.
- Notes are never shown publicly (anyone could type anything) and the panel has no cookie view either: a hundred thousand people leave cookies on the night and nobody sifts through them. There is no moderation; a cookie counts until its event is deleted.
- Cookies are accepted only while an event is live; any other time the write is a 409. The tally reaches the CDN on the back of the once-a-second live-object writes that only happen during a live event, so no extra write path exists for cookies.
- The per-person limit is an admin setting (`app_setting cookie_limit_per_person`), read at the time a cookie is left, so it can change mid-event. The API enforces it with a count query inside the insert transaction.
- Types are admin-managed rows, so a sponsor can have a branded cookie for a year by adding a type with their icon (a library icon or an uploaded SVG). Types are locked while an event is live: create, edit, deactivate, and delete all return 409 until the event ends, so the leaderboard never changes shape mid-event. A type is deleted only while no cookie references it; otherwise it is deactivated.

## 6b. Red-Nose, the beacon app (Android, React Native)

One app: it runs on a dedicated Android phone in the helicopter and posts location. The pilot never touches it. Its debug mode is always there for whoever holds the phone; the API and the panel know nothing about it, because a beacon is a key and nothing more.

Staying alive (the part React Native cannot do; a small Kotlin foreground service owns GPS and the send loop so JS being frozen or killed changes nothing):

- Red-Nose is a persistent system app (`/system/app`, `android:persistent="true"`) on a rooted phone, so the platform restarts it immediately if it dies and never low-memory-kills it. A location foreground service with a persistent notification owns GPS and the send loop; a boot receiver starts it after reboot and `START_STICKY` covers a service kill, with a Magisk `service.d` script as the root backstop. No WorkManager job and no exact alarm; the persistent process and root replace them.
- No device owner mode. Root does the provisioning from the shell: every runtime permission is granted, the Doze allowlist, stay-awake-while-charging, and location always on are set, safe boot is off, and OTA is blocked by the patched boot image. The bootloader stays unlocked (a Magisk-patched boot cannot pass verified boot locked) and a factory reset from Settings stays possible; both are accepted for a phone mounted in the aircraft. The first-run checklist verifies each item from system APIs; nothing waits on a user tap and the app never asks for a permission. There is no kiosk: the phone stays usable for other apps, and whatever the beacon needs (airplane mode off, location on, mobile data on, battery saver off, its permission grants, the Doze allowlist) the service switches back on with root the moment someone switches it off.
- The phone is ours, bought outright with its own SIM, always on USB power in the aircraft. Requirements, not a brand: Android 10 or newer; an unlockable bootloader (root is the baseline and needs it, and carrier-locked US phones usually cannot be unlocked); Google Play services for the fused provider; decent GPS. Root (Magisk) is the foundation, not a fallback: it is what lets Red-Nose be a persistent system app and what lets provisioning configure the device entirely from the shell. Unplugged and untouched it lives as long as the battery, nothing more.
- Location: fused provider, high accuracy, one fix per second, GPS-only fallback toggle. Every payload carries the fix time (`recordedAt`), not the send time.

Transport, websocket first:

- The Kotlin service holds a SignalR connection to the gateway hub (official Java client, WebSockets only, negotiation skipped), joins the private channel `wmsfo-api:ingest` with the beacon key as credential, and sends each fix with `SendToChannel`. The invoke resolves only after the API answered 2xx, so every point gets a delivery receipt.
- Live only. The service holds exactly one thing: the latest fix. Each new fix replaces it, every send attempt sends whatever is current, and nothing is stored. When service returns the first message out is where he is now, never where he was. A cellular gap leaves a gap in that year's recorded route and that is fine.
- While the socket is down the current fix goes out over `POST /locations` instead. Same payload, same handling.
- Nothing ever gives up. There is no maximum attempt count anywhere in the service, no state that means "stopped". Backoff is short and capped: 1 s, 2 s, 3 s, then every 5 s forever, for both the socket and the HTTP fallback, and it resets to 1 s on any success. Losing service ramps effort up, not down: the connectivity callback fires an immediate retry the moment a network comes back, and while no network is reported the service still probes on the 5 s tick because Android's network state lies in the air. Re-join the channel after every reconnect and on `channelEvicted` (the gateway re-authorizes roughly every 15 minutes); once the socket is back, stop posting.
- Consequence for the API: setting `realtime_auth_path` makes every `wmsfo-api:*` channel private, so the auth callback allows the public topics (`location`, `event`, `cookies`) with no credential and requires a valid beacon key only for `ingest`, returning the beacon id as `identity`.

Telemetry goes out as a 15 s heartbeat independent of GPS fixes (the list is in §4) so the admin panel shows beacon health without anyone touching the phone.

Debug mode: the full telemetry set on screen, plus a live log of fixes, socket state changes with drop reasons and reconnect attempts, per-fix receipt latency, failures, service restarts; ring-buffer file log with an upload button to the API's log endpoint; a replay mode that plays a past year's route into the dev API as the end-to-end test of the whole pipeline.

Enrollment: scan the panel's QR, exchange the one-time token for a key, store in Keystore-backed encrypted storage. Distribution is a Magisk module (the signed APK plus the `service.d` watchdog) flashed on the rooted phone; no store, no Play review. Before December the real device gets a month-long soak against dev with reboot, airplane mode, and kill-from-recents drills.

## 6c. Public site rewrite

Vite, React, TypeScript, a static single-page app. Vercel recommends Next.js, but Next earns its keep with server rendering and server functions, and this site has neither by design: every read is a CDN file or a hub event, the only writes are three authenticated POSTs. A Vite build is static files, deploys on Vercel with no functions, and runs from S3 and CloudFront unchanged if that ever matters. Same Vercel projects and git flow as today: `main` to production, `dev` to preview.

- **One data loop.** A single store holds the live object and the snapshot. On load: fetch `live/location.json`, fetch `snapshotUrl`, render. Then join `wmsfo-api:location` on the hub (official SignalR client, WebSockets only, negotiation skipped, re-join on every reconnect) and poll the CDN at `pollIntervalMs` as the floor, tightening when hub events go quiet. `eventStatusId` picks the screen; a changed `snapshotUrl` refetches the snapshot. Nothing else fetches anything. Pages, sections, media URLs, icons, and site settings all come out of the snapshot; the site holds a section registry and a block registry and renders whatever the document says, skipping any kind it does not know.
- **Screens** are one page per status, named after the status (planned, scheduled, live, ended, cancelled) plus a no-event page, every one of them admin-composed from the section palette (§6d). The site never hard-codes what a status screen contains; it renders the page whose role matches `eventStatusId`. Live sections (map, countdown, leaderboard, latest message, sponsor carousel) read the live object and the snapshot; everything else is content. Static pages (about, donate, cheer meter, sponsors, route, contact, and anything an admin adds) are pages with slugs.
- **Map:** Google Maps JS with the existing key. The live screen (map style picker, terrain toggle, snow, the flight history toggle, time labels, location prompt, liftoff timer) is rebuilt from scratch; the six map styles carry over and the picker stays.
- **Visual design is decided.** Direction "North Pole Night": a midnight-navy dark theme and an ice-and-paper light theme, one ice-blue accent, gold for the funds ring and the star, holly red for status. Light, dark, or follow the system, the visitor's choice, defaulting to system; no other visitor-facing theme controls. IBM Plex Sans for prose and UI, IBM Plex Mono for any value that came from the API at runtime, Bricolage Grotesque for the two heading sizes. Seasonal layers (snow, a string of lights on the header, frost glass on the liftoff card and live overlays) are the only decoration; snow and lights have site-setting defaults and a per-visitor off switch. Tokens live in one file with a contrast unit test, components never write a hex, hover is a 120 ms border change, radii are 6 and 10 px, the public site is hand-rolled CSS with no UI library. Library icons render inline so they take the accent. The reference mock is the theme studio artifact.
- **Accounts:** the site's own sign-up, confirmation, sign-in, and password-reset pages, themed like everything else, talking to the people pool through the Cognito API (SRP, so the password never leaves the browser in clear); no AWS-hosted page anywhere on the public site. Sign-in is a link in the menu. Signed-out users see everything; signed-in users get the alerts page and the leave-a-cookie control on the live screen.
- **Small things that carry over:** wake lock on the live screen (the Screen Wake Lock API replaces nosleep), analytics only on the production origins, the reduced-motion check for snow and animations, the in-app-browser warning for location.
- **Config** is Vercel env vars per project: CDN base URL, hub URL, API base URL, Cognito pool and client ids. No secrets in the bundle; the Maps key stays referrer-restricted.
- **Testing:** Vitest for the store and the status switch; Playwright against the preview site and the dev stack for the full flow, including a scripted status walk from planned to ended with a replayed route from Red-Nose's debug mode.

## 6d. Content: pages, sections, media, icons

The goal is a site an admin runs without a developer: every page, every piece of text, every image, every icon is content in the panel, and a deploy is needed only for a new *kind* of section. That line comes from the portfolio's content system and it is the right line: instances are data, kinds are code, and there is no layout engine. Sections stack.

**Pages.** A page is a row: `slug`, `title`, `nav_label` (null keeps it out of the nav), `nav_position`, `is_hidden`, and a `role`. Roles: `none` for ordinary pages, or one of `no_event`, `planned`, `scheduled`, `live`, `ended`, `cancelled`. Exactly one page per non-`none` role (partial unique index), and those six render at `/` according to the current status; ordinary pages render at `/<slug>`. Slugs are one lowercase path segment; `auth`, `preview`, `api`, `admin`, and `assets` are reserved, and the token landing paths under `/alerts/` and `/auth/` are site code, not pages. Navigation is derived from pages (label, order, hidden) plus any extra links in the site settings. Deleting a page deletes its sections; the panel says so.

**Sections.** A section belongs to one page, has a `kind`, a `position`, `is_hidden`, a `data` JSON blob validated by the schema for its kind, and a `presentation` JSON blob validated by one shared schema: width (`full`, `wide`, `narrow`), alignment, background (none, a named theme token, or a media reference with an overlay), spacing, an optional decoration icon before and after, and an optional anchor for in-page links. Presentation is deliberately a fixed vocabulary so a tweak is a dropdown, not a new kind. Some kinds have repeatable items (a gallery, a link list) in a `section_items` table with the same shape.

The palette, each kind one React component plus one schema:

| Kind | Content or live | Data |
|---|---|---|
| `rich_text` | content | blocks (below) |
| `hero` | content | title, tagline, icon, up to two call-to-action links; the background image is the section's presentation background |
| `media` | content | items: media plus caption; layout `single`, `grid`, `carousel` |
| `links` | content | items: the shared `Link` type with an optional icon each |
| `icon_row` | content | items: icons, size, spacing (decoration) |
| `divider` | content | style |
| `funds_ring` | live | heading; reads `fundsPercent` |
| `countdown` | live | heading; reads `scheduledAt`; renders only while the status is scheduled |
| `event_times` | live | which of scheduled time, liftoff time, end time, and time airborne to show, with labels; reads the event |
| `latest_message` | live | heading; reads the latest message |
| `map` | live | map styles offered, default style, controls and overlays on or off, default center and zoom; reads the live object and the event's embedded flight history; allowed only on the `live` page |
| `leaderboard` | live | heading, variant `panel` or `full`; reads the tally and cookie types |
| `sponsor_carousel`, `sponsor_grid` | live | heading, which logo size; read the sponsor list |
| `route_preview` | live | heading, style `image` (a linked picture) or `viewer` (pan and zoom over the original), disclaimer; reads the event's route poster |
| `cookie_control` | live | heading, copy; the leave-a-cookie control |
| `alerts_signup` | live | heading, copy; the subscribe form |
| `contact_form` | live | heading, copy, success text; posts to the API |

Live sections carry configuration only; their data is the live object and the operational parts of the snapshot, exactly as today. An unknown kind renders nothing and logs, so a document published before a site deploy never breaks it.

**Blocks** are the rich text model inside `rich_text`: `heading`, `paragraph`, `list`, `quote`, `media`, `links`, `icon`, `divider`. Every piece of text a section or block carries is a constrained inline markdown (bold, italic, inline code, links, inline icons written as `{icon:candy-cane}`, and the placeholders `{event:name}`, `{event:year}`, `{event:scheduledAt}` filled from the current event). Raw HTML is never stored and never rendered. Unknown block kinds render nothing.

**Icons anywhere.** An icon is a value type `{ source: "library" | "media", id }` used by every place that takes one: section decorations, hero, link items, icon rows, icon blocks, inline in text, nav entries, cookie types, and the site settings (favicon, logo). The library is a curated set of about sixty Christmas and winter two-tone icons in one visual style (a theme-coloured stroke and tint over a few fixed fills: red, gold, green, snow, cocoa) (Santa, sleigh, reindeer, candy cane, tree, ornament, gift, snowflake, star, bell, stocking, cookie, mug, mitten, helicopter, map pin, and the like), shipped in the API repository, written to the bucket once per deploy, and published into the snapshot as a map of id to CDN URL; `media` points at an uploaded SVG. Admins add icons by uploading SVGs; the library grows in code. Every SVG, library or uploaded, passes the same validator (no scripts, handlers, foreign objects, or external references). Uploaded SVGs render through `<img>` only; the library also ships inside the site's bundle as inline components on one drawing rule, so library icons take the theme's colour.

**Media.** The portfolio's pipeline, unchanged in shape: the admin asks the API for an upload URL, PUTs the bytes straight to S3 with a pending tag, then confirms; the API verifies the object, records size and dimensions, strips the tag, and for raster images derives width variants (480, 960, 1600) as WebP so the site can use `srcset` and a design change never means re-uploading. A raster whose longest side is 2048 px or more also gets a Deep Zoom tile pyramid beside it, so a poster-sized image can be explored tile by tile. Keys are `media/{uuid}/{filename}` and variants sit beside them; every object carries a one-year immutable cache header; nothing is ever overwritten and nothing is ever invalidated. Abandoned uploads expire by lifecycle rule on the pending tag. Unreferenced media is found by scanning references (working set, retained versions, sponsor logos, cookie artwork, site settings) after every publish, tagged orphaned with a 30-day grace and a 7-day undo window, and expired by a second lifecycle rule. Sponsor logos are media assets chosen from the library, and cookie types carry an icon; the snapshot carries a `media` map of id to URL (with variants) and every renderer resolves through it. Raster uploads accept PNG, JPEG, WebP, and GIF up to 20 MB; SVG up to 1 MB. A media asset in use anywhere cannot be deleted.

**Site settings** are content too and publish with the pages: site name and tagline, logo and favicon icons, extra nav links, footer links and footer text, the seasonal layer defaults (snow, lights), the donate link, the contact address shown on the site, and analytics on or off. Enough for the tweaks you would otherwise ask for as deploys, without becoming a style editor. Colours and type are not settings.

**Sponsors** have no tiers. The site lists them largest gift first; on the tracker each logo stays up for a time proportional to the gift (a per-dollar rate and a floor, both admin settings). An admin can pin any sponsors to the top in any order and override any sponsor's time, per year.

**Draft, publish, versions, preview.** Content is a working set the admin edits freely; writes are validated leniently (typed but incomplete is fine). Publish validates strictly, snapshots the whole content document as an immutable version, rebuilds the snapshot object, and writes the live object. The last 50 versions are kept; restoring one loads it into the working set, and publishing then makes it the new version, so a rollback is restore and publish. Event state, sponsors, beacons, cookies, and settings stay immediate writes; they are operations, not editorial. Preview is the real public site in an iframe with a 15-minute token, rendering the draft document through the same code that renders production, so preview cannot drift; the panel can point the preview at any page, including a status page whose status is not current.

**Rules that keep later requests cheap.** Every section and block kind is additive and versioned by its schema; new optional fields need no migration. The presentation vocabulary, the icon value type, the `Link` type, the media reference, and the block model are shared primitives, defined once and reused by every kind. Forms in the panel are generated from the schemas, so adding a field is a schema change and nothing else. The document carries a `schemaVersion` and the site ignores what it does not know. The registry is the only place a new kind is wired in, on each side.

## 7. Schema sketch

Tables in one schema, all ids `bigint identity`, all timestamps `timestamptz`, soft deletes only where an admin needs undo.

```
event, event_status, event_status_history, event_message, route
beacon              (…, is_active: exactly one true, partial unique index), beacon_enrollment_token
location            (event_id, beacon_id, seq, recorded_at, received_at, lat, lng, speed, altitude, heading, accuracy)
sponsor, sponsor_year (…, pinned_position, linger_ms_override per year)
person, subscriber, cookie, cookie_type
contact_message
api_key             (name, key_prefix, key_hash, all_capabilities, capabilities[], expires_at, revoked_at)
page, section, section_item, content_version, site_setting_draft (single row), media_asset
app_setting         (key, value jsonb, updated_by, updated_at)   poll_interval_ms (default 5000), cookie_limit_per_person (default 10), sponsor_linger_ms_per_dollar
snapshot            (single row: version bigint, url, s3_key, built_at)   rewritten in the same transaction as any snapshot-affecting write
outbox              (id, topic, payload jsonb, created_at, published_at)
```

Plain lat/lng columns, no PostGIS. Every knob the admin can turn lives in `app_setting` and is edited from the panel; the API reads it per request (cheap, cached a few seconds) so changes land without a deploy.

Indexes that matter: `location (event_id, seq desc)` (current location is the top row for the active beacon), partial unique on live event, `subscriber (channel, address)` unique, `cookie (event_id, person_id)`, `outbox (published_at) where published_at is null`.

Migrations live in the repo (EF Core, applied on boot with an advisory lock, same as the gateway). Legacy tables are not carried over.

## 8. Leader chores and the gateway

Chores that must run once per fleet: outbox publishing, alert fan-out, stale-beacon flags, nightly cleanup.

Done 2026-09-05: `GET /internal/leader` is deployed on the fleet (REALTIME.md §7) and verified from inside a container. Containers reach the internal listener at the Docker bridge address on port 8080; the hostname `gateway` does not resolve, so the URL comes from configuration. The publish token is injected only after the service has been upserted once from the dashboard.

Contract the API codes against:

```
GET http://gateway:8080/internal/leader
X-Gateway-Realtime-Token: <this service's publish token, from env GATEWAY_REALTIME_TOKEN>

200 { "instanceId": "i-…", "isLeader": true, "leaderInstanceId": "i-…", "evaluatedAt": "…" }
```

Rules the API follows: `evaluatedAt: null` or any request failure means "not leader"; leadership may overlap for a loop during a hand-off, so every chore is idempotent (outbox rows are claimed with `update … where published_at is null returning`, alerts are keyed by `(subscriber, outbox_id)` unique); poll it every 2 s with a 1 s timeout, treat an `evaluatedAt` older than 90 s as follower (the gateway refreshes it every 30 s), never carry `isLeader: true` across a missed poll (the pattern REALTIME.md recommends). Locally, with no gateway, an env override `WMSFO_FORCE_LEADER=true` runs the chores.

## 9. Moving the legacy data

One-off migration tool in the new repo, run once against a fresh database, idempotent so it can be rerun:

- `flight_history` years 2020 to 2025 become `event` rows (status ended) plus `location` rows with a synthetic beacon "legacy". The 2025 rows are also written out as a route JSON to the bucket and linked as that event's `route`, so the first new event has a route to inherit.
- `event_updates` become `event_message` rows on the matching year.
- `sponsors`, `sponsor_years`, `sponsor_settings` map straight across; each legacy logo is imported into the media library as an asset with variants and linked from the sponsor.
- `funds` latest per year lands on `event.funds_percent`.
- `messages` (contact form) copy across.
- `tracking_mode*`, `tracki_device*`, `event_mode_override`, `gps_location`, `liftoff` are retired; nothing reads them.

Cut-over: freeze the old API, run the migration, point the site and the panel at the new API, delete the old service from the manifest.

## 10. Decided

- Content system modeled on the portfolio (§6d): pages with roles, typed sections, blocks, media pipeline, icons as a value type, site settings, draft and publish with versions, iframe preview. Instances are data, kinds are code, sections stack.
- Two Cognito groups: `editor` (content, media, sponsors, publish) and `admin` (everything); both need TOTP.
- The bucket is private; CloudFront reads it through origin access control. Browser uploads go straight to S3 with presigned URLs.
- The icon library ships in code, about sixty curated icons, extendable by SVG upload.
- Raster media gets 480, 960, and 1600 pixel WebP variants at confirm; the site uses `srcset`.
- No embeds in year one; an `embed` kind with an allow-listed provider set is the later addition.

- Gateway leader endpoint: deployed and verified (§8).
- Cognito: two brand new pools, dev and prod, admins as a group with MFA.
- Cookies carry no location; plain lat/lng for locations, no PostGIS.
- Cookie limit, poll interval, and the other knobs are admin settings (§7); defaults are a 5 s poll interval and 10 cookies per person.
- Alerts are email only for year one; sign-in is by email.
- Cookies: public UI is a per-type tally sorted by popularity, on the live and ended screens; accepted only while live; types locked while live; notes are admin-only; nothing about Santa eating them.
- Same service and repo names; legacy repos renamed `<name>-legacy`.
- Red-Nose: React Native UI over a native Kotlin service, a dedicated rooted phone we own that meets the requirements in §6b, installed as a persistent system app through a Magisk module and provisioned entirely from the shell, websocket primary with HTTP fallback, retries capped at 5 s and never abandoned, latest fix only, nothing stored on the phone.
- Public site: full rewrite as a Vite + React + TypeScript static SPA on Vercel (§6c), Google Maps stays.
- Visual design (2026-09-11): North Pole Night direction, light/dark/system as the only visitor theme control, Plex Sans and Mono with Bricolage Grotesque headings, hand-rolled CSS with tokens and a contrast test, no UI library on the public site, library icons inline. The accent, surface, and font-pairing site settings and the per-visitor theme chips are gone.
- Route: the public route is a poster image in a pan-and-zoom viewer; the route JSON is a flight recording, read from the CDN by replay and tests and embedded in the snapshot as the event's flight history for the tracker's projected-route toggle; the tracker shows only Santa's current position, never a trail.
- Sponsors: no tiers; largest gift first; tracker time proportional to the gift; per-year pin order and time override in the panel.
- API keys: `wak_` keys with every capability or a chosen subset and an optional expiry, minted by a TOTP admin, reaching every admin group but the key endpoints.
- Admin panel moves to Vite alongside the Cognito rewiring.
- Beacons (2026-09-12): no roles. A beacon is a key; its heartbeat carries a tiny typed health core plus a free debug object the panel shows as a JSON tree; logs are open to every beacon; Red-Nose's debug mode is always available on the phone.
- Go-live gate (2026-09-12): an event goes live only with a healthy active beacon (heard from within the stale window; the socket is not required).
- Cookies (2026-09-12): no moderation, no admin cookie view; a cookie type can be deleted while nothing references it.
- Route poster (2026-09-12): a Deep Zoom tile pyramid cut at upload and served from the CDN; the site's viewer is OpenSeadragon with fullscreen.
- Site accounts (2026-09-12): the site's own themed auth pages over the Cognito API; the hosted UI is used only by the admin panel.
- Two more beacons (2026-09-12): a simulator beacon (replays a past year, control page behind the admin pool) and a legacy beacon (polls the Heroku tracker), both fleet services and ordinary enrolled beacons.
- Admin panel usability (2026-09-12): every editable row has an edit control; the flight recording upload shows the JSON shape it expects.

## 11. Still open

Nothing at the moment. Add here as it comes up.
