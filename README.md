# Casual Party Games: authoritative server

Colyseus 0.18 + TypeScript server for the **Casual Party Games Template**, a Unity template for online party games:
obstacle-course races, survival and elimination rounds, team modes, bots, parties of friends, missions, a battle pass,
timed events, a character collection and in-app purchases.

The server owns every rule. It runs each match (movement, collisions, hazards, skills, finishes and eliminations),
keeps the accounts and the economy in MySQL 8.4 and hands out the rewards. The Unity client only sends intents
(`input`, `ready`, `chat`...) and draws what the server says happened, so a modified client cannot move faster, finish
first or give itself currency.

The Unity project also ships an **Offline** backend that runs the same rules in C#. You can build the whole game
offline first and switch to this server later without changing gameplay code.

Contents: [Requirements](#requirements) | [Where this folder goes](#where-this-folder-goes) |
[Quick start](#quick-start-development) | [Connecting the Unity client](#connecting-the-unity-client) |
[Game data](#game-data) | [Configuration](#configuration) | [Production](#production) | [Database](#database) |
[Scripts and tests](#scripts-and-tests) | [Project layout](#project-layout) | [How it works](#how-it-works) |
[Rooms and HTTP API](#rooms-and-http-api) | [Extending](#extending) | [GM console](#gm-console) |
[In-app purchases](#in-app-purchases) | [Documentation](#documentation) | [License](#license)

## Requirements

| Tool    | Version                                                                                                                                    |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Node.js | 22.13 or newer (24 LTS recommended)                                                                                                        |
| MySQL   | 8.4 LTS. The server creates and updates its own tables.                                                                                    |
| Redis   | Optional, 6.2 or newer. Only needed to run several server processes behind a sticky load balancer. One process needs no Redis at all. |

Built with [Colyseus](https://colyseus.io) (rooms and WebSockets), Express 5 (HTTP API), TypeORM + mysql2 (storage),
the official Redis client and zod.

## Where this folder goes

This repository is the `Server` folder of the template. Clone it **into your Unity project, next to `Assets`**:

```
YourUnityProject/
  Assets/
  Packages/
  ProjectSettings/
  Exports/         written by Unity's "Export to Server"
  Server/          <- this repository
```

```bash
cd YourUnityProject
git clone https://github.com/BizachiCode/Casual-Party-Games-Server.git Server
```

The server runs on its own. Two tools reach one folder up: `compose.yaml` mounts `../Exports/Server` and
`npm run content -- export` writes to `../Exports/Server` by default, the folder Unity's exporter uses. Unity does not
import anything outside `Assets`, so the server code never ends up in a game build.

## Quick start (development)

### Option A: Windows, one command

With MySQL 8.4 installed in its default folder (it does not need to be configured or running), open PowerShell in the
Unity project folder and run the script that ships with the server:

```powershell
powershell -ExecutionPolicy Bypass -File Server/tools/dev-backend.ps1
```

The first time it creates a private database in `Server/data/mysql` (port 3316, it does not touch any other MySQL you
have), creates the `party` schema, installs the packages and starts the server on `ws://127.0.0.1:2567`. Add
`-MySqlHome "D:\path\to\MySQL Server 8.4"` if MySQL lives elsewhere.

### Option B: any system

1. Create a database and a user in MySQL 8.4:

   ```sql
   CREATE DATABASE party CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
   CREATE USER 'party'@'localhost' IDENTIFIED BY 'ChooseAPassword';
   GRANT ALL PRIVILEGES ON party.* TO 'party'@'localhost';
   ```

2. Install the packages and create your settings file:

   ```bash
   cd Server
   npm ci
   cp .env.example .env
   ```

3. In `.env`, remove the `#` in front of `DATABASE_URL` and fill it in (letters and digits only in the password, it is
   part of a URL):

   ```env
   DATABASE_URL=mysql://party:ChooseAPassword@127.0.0.1:3306/party
   ```

4. Start the server:

   ```bash
   npm start
   ```

The first start creates every table. `npm start` restarts the server whenever a source file changes.

### Check that it runs

Open http://127.0.0.1:2567/health. It answers with the content revision the server runs:

```json
{ "ok": true, "protocol": 7, "revision": "party-v7-..." }
```

In development Colyseus also serves the live room monitor at `/monitor` and its playground at `/`. Both are turned off
when `NODE_ENV=production`.

## Connecting the Unity client

1. Open the **Menu** scene, select **Party Game** and open the **Backend Settings** asset of its **Backend Manager**.
2. Set **Option** to **Colyseus Web Socket** and **Server Url** to `ws://127.0.0.1:2567`.
3. Press **Play**. The game signs in with a guest account of that device and **PLAY** puts you in a lobby, filled with
   bots after a few seconds.

To test a phone on your Wi-Fi, add `HOST=0.0.0.0` to `.env` and use your computer's local IP as the Server Url
(`ws://192.168.0.20:2567`). Store builds, iOS and WebGL need `wss://` with a real certificate: see
[Production](#production).

## Game data

Courses, characters, modes, playlists, matchmaking queues, the battle pass, events and the store are authored in
Unity as ScriptableObjects on the `GameInstance` prefab. **Tools > Casual Party > Export to Server** writes everything the
server reads to `game_config/`, so the Offline backend and this server always play the same content. The folder ships
with the template's data, so the server starts right away.

| File                      | Content                                                                              | Read by                                     |
| ------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------- |
| `party-courses.json`      | match rules (tick rate, timers, movement, bots), courses, modes and playlists        | `modules/content/active-content.ts`         |
| `party-characters.json`   | the characters (rarity, shards, crafting cost), gacha banners, starting currency     | `modules/content/active-content.ts`         |
| `party-goals.json`        | daily and weekly missions, achievements                                              | `modules/content/active-content.ts`         |
| `party-matchmaking.json`  | the queues (players, search time, bots, lobby, backfill, rules), private rooms, parties | `modules/matchmaking/matchmaking.catalog.ts` |
| `season.json`             | scheduled battle pass seasons with a free and a premium track                        | `modules/season/season.catalog.ts`          |
| `events.json`             | timed events: a queue played on its own course or playlist, with event missions      | `modules/events/events.catalog.ts`          |
| `party-store.json`        | real-money Stars packs (a missing file means no store)                               | `modules/store/store.catalog.ts`            |
| `name-blocklist.txt`      | extra words refused in player names, one per line                                    | `modules/account/name-rules.ts`             |

Every file is validated at startup against the others (an event that names a missing queue, a mission for a course
that does not exist...), so a typo stops the server with a message instead of reaching a player.

The server reads `game_config/` when it **starts**. After a change in Unity, export again and restart the server. A
game build and the server must carry the same revision; a mismatch refuses the join with "Client/course version
mismatch".

With `PARTY_ADMIN_KEY` set and the same key in the Backend Settings (**Admin Key**, kept on that computer only), Export
to Server also uploads the files to a running server (`POST /api/admin/game-config`). They are checked together,
saved, and under PM2 the server restarts by itself after the running matches finish (`PARTY_DRAIN_SECONDS`).

## Configuration

Settings come from `.env` (`.env.development` and `.env.production` also work). `.env.example` documents every
variable with its default and range; an invalid value stops the server with a message naming it. The ones you usually
touch:

| Variable                                                       | Default                     | Meaning                                                                                       |
| -------------------------------------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                                 | required                    | `mysql://user:password@host:3306/database`                                                    |
| `PORT`, `HOST`                                                 | `2567`, all interfaces      | HTTP and WebSocket port, and the interface to bind                                            |
| `ALLOWED_ORIGINS`                                              | empty (any origin)          | comma-separated browser origins allowed to use the API and sockets (WebGL builds)             |
| `REDIS_URL`, `PARTY_REDIS_PREFIX`                              | empty, `party:production`   | share seats, presence and rate limits between several processes                               |
| `PARTY_ADMIN_KEY`                                              | empty                       | enables the GM console and the admin API; use 32+ random characters                           |
| `PARTY_ADMIN_ALLOWED_IPS`                                      | empty (any address)         | addresses or CIDR ranges allowed to reach `/gm` and `/api/admin`                              |
| `PARTY_ADMIN_MAX_FAILURES`, `PARTY_ADMIN_LOCKOUT_SECONDS`      | `10`, `900`                 | wrong admin keys before an address is locked out, and for how long                            |
| `PARTY_TRUST_PROXY_HOPS`                                       | `0`                         | how many trusted reverse proxies (nginx, Caddy) stand in front, so rate limits see real IPs   |
| `PARTY_API_REQUESTS_PER_MINUTE`                                | `240`                       | REST requests per address per minute                                                          |
| `PARTY_DRAIN_SECONDS`                                          | `45`                        | on shutdown, how long running matches may finish                                              |
| `PARTY_MAINTENANCE`, `PARTY_MAINTENANCE_MESSAGE`               | `0`, empty                  | start in maintenance mode with a message for the players                                      |
| `PARTY_RENAME_COOLDOWN_HOURS`                                  | `24`                        | hours between name changes (0 = no limit; the first change is free)                           |
| `PARTY_CONTENT_BUNDLE`                                         | empty                       | run an exported content bundle instead of the catalogs in `game_config`                       |
| `PARTY_SEASON_CATALOG`, `PARTY_EVENTS_CATALOG`, `PARTY_MATCHMAKING_CATALOG`, `PARTY_STORE_CATALOG` | the files in `game_config` | point one catalog at another file |
| `PARTY_IAP_*`                                                  |                             | real-money purchases, see [In-app purchases](#in-app-purchases)                               |

## Production

```bash
npm ci
npm run build                                   # TypeScript -> build/
NODE_ENV=production npm run start:prod          # or: pm2 start ecosystem.config.cjs
```

- **PM2.** `ecosystem.config.cjs` starts one process named `casual-party-server`, waits for it to be ready and gives it
  60 seconds to drain on reload. Deploy updates with `pm2 reload casual-party-server --update-env`.
- **Docker.** `docker compose -f compose.yaml up -d --build` runs the server, MySQL 8.4 and Redis with a read-only
  file system and no capabilities. Set `PARTY_MYSQL_PASSWORD` and `PARTY_MYSQL_ROOT_PASSWORD` first; the content
  bundle is mounted from `../Exports/Server`.
- **One process per server.** Live matches and party invitations live in the memory of the process that hosts them.
  Run more instances only behind a sticky load balancer, with `REDIS_URL` set.
- **TLS.** Put a reverse proxy (Caddy, nginx) with a certificate in front of the server and use `wss://` in Unity.
  Phones and WebGL refuse plain `ws://`. Set `PARTY_TRUST_PROXY_HOPS` to the number of proxies, and `ALLOWED_ORIGINS`
  for WebGL builds.
- **Health.** `GET /health` (alive and content revision) and `GET /ready` (503 when MySQL or Redis is unreachable,
  in maintenance or while draining) are meant for a load balancer. `GET /api/service/status` is what clients show
  (maintenance, restarts).
- **Shutdown.** On SIGTERM the server stops accepting players, closes the lobbies that have not started, lets the
  running matches finish for up to `PARTY_DRAIN_SECONDS`, then exits.

The template documentation has a complete step-by-step guide for an Ubuntu VPS (Node.js, MySQL 8.4 in Docker, PM2 and
Caddy with free HTTPS): see [Documentation](#documentation).

## Database

The schema lives in TypeORM entities (`src/infrastructure/database/entities/`) and migrations
(`src/infrastructure/database/migrations/`). Pending migrations run on every start under a MySQL lock, so several
processes can start together. To change the schema, add an entity or a column and a **new** migration file (never edit
one that already shipped), and register it in `migrations/index.ts`.

Backups:

```bash
npm run db -- backup FILE            # consistent snapshot of DATABASE_URL as checksummed JSON lines
npm run db -- verify FILE            # format, schema and checksum; no database needed
npm run db -- restore FILE           # into an empty database at DATABASE_URL (migrated first)
```

## Scripts and tests

| Script                                             | What it does                                                                                                                              |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `npm start`                                        | development server with reload (`tsx watch`)                                                                                              |
| `npm run build`, `npm run start:prod`              | compile to `build/` and run it                                                                                                            |
| `npm run typecheck`                                | type-check `src/` and `test/`                                                                                                             |
| `npm run lint`                                     | ESLint (typescript-eslint, descriptive names, one declaration per statement)                                                              |
| `npm run format`, `npm run format:check`           | Prettier, 120 columns                                                                                                                     |
| `npm test`                                         | unit and integration tests (mocha). Needs `PARTY_TEST_MYSQL_URL`: each test creates its own `party_test_*` schema and drops it afterwards. `PARTY_TEST_REDIS_URL` enables the Redis test. |
| `npm run test:container`                           | the Docker image with a real MySQL and Redis (needs Docker)                                                                               |
| `npm run content -- export \| validate \| install` | content bundles without Unity                                                                                                             |
| `npm run db -- backup \| verify \| restore FILE`   | database backups                                                                                                                          |
| `npm run loadtest -- --numClients 32`              | simulated players that run, jump and dive in real matches                                                                                 |

`PARTY_TEST_MYSQL_URL` needs an account that may create and drop databases. Point it at a local test instance, never
at production, for example `mysql://root:password@127.0.0.1:3306/mysql`. The tests only ever drop the `party_test_*`
schemas they created.

## Project layout

```
src/
  index.ts              entry point
  app.config.ts         the Colyseus server of this process (the file Colyseus Cloud looks for)
  app/
    server.ts           rooms (matchmaking, party, party_private, squad) and lifecycle hooks
    container.ts        composition root: every repository and service, built once
    http.ts             middleware order and every HTTP route
  config/               env.ts (validated settings), paths.ts
  infrastructure/
    database/           TypeORM data source, entities/, migrations/, backups
    redis/              seat leases, presence and rate windows shared between processes
  modules/<feature>/    *.routes.ts (HTTP) -> *.service.ts (rules) -> *.repository.ts (MySQL)
  shared/               errors, rate limits, admin guard, text helpers
test/                   mocha tests per area; integration/ holds the Docker smoke test
game_config/            the game data exported from Unity
certs/apple/            Apple root certificate for App Store receipts (public)
loadtest/               the Colyseus load test
tools/                  dev-backend.ps1: a private MySQL and the server on Windows, in one command
```

| Module                 | Responsibility                                                                                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `match`                | the `PartyRoom`, the deterministic `PartySimulation` (`simulation/`: motor, course rules, bots, hazards, fields, skills, animation), the generated match wire and the results |
| `matchmaking`          | the queues: the rules catalog, pluggable rules (skill, region, account), the `MatchmakingQueue` (groups, short starts, backfill, parties as one unit) and the `matchmaking` room |
| `squad`                | the `squad` room: a party of up to four friends gathered in the menu; the leader sends everyone into the same match                                                            |
| `account`              | sign-up, sign-in, device guest accounts (upgradable to a username and password), sessions, profile, name rules, account deletion                                               |
| `social`, `presence`   | friends, blocks, lobby and party invitations, who is online and where                                                                                                           |
| `collection`           | Stars, shards, the gacha with pity, crafting, the equipped character                                                                                                            |
| `progression`          | daily and weekly missions (they also add battle pass XP) and achievements                                                                                                       |
| `ranking`              | profile totals, monthly boards, time-trial records                                                                                                                              |
| `season`               | the battle pass: scheduled seasons, free and premium tracks, XP from matches and missions                                                                                       |
| `events`               | timed events played on their own course or playlist, with event missions                                                                                                        |
| `store`                | real-money Stars packs, Google Play and App Store receipt checks, one delivery per store transaction                                                                             |
| `content`              | loading, validating and staging the catalogs, and the upload from Unity's exporter                                                                                              |
| `moderation`, `admin`  | player reports, bans and mutes, the match chat log, the GM console and its API                                                                                                  |
| `operations`           | readiness, maintenance, draining on shutdown, service metrics                                                                                                                   |

## How it works

- **The server decides.** Clients send intents. Positions, hits, finishes, eliminations, results and every balance are
  computed here. No route lets a client add currency or report a result.
- **Two copies of the simulation, one behavior.** The Unity client predicts its own runner with a C# port of
  `modules/match/simulation` so movement feels instant online, and the Offline backend plays whole matches with it.
  The simulation is deterministic (no `Math.random`, wall clock or database inside a tick), so both sides produce the
  same numbers. A rule changed on one side must change the same way on the other.
- **The wire is mirrored.** `modules/match/wire/match-wire.ts` and the client's `MatchWire.cs` declare the same native
  Colyseus Schema fields in the same order. Only append fields, on both sides, and bump the protocol in the content
  catalog when the wire changes.
- **Validate at the edge.** Settings are validated in `config/env.ts`, payloads are checked before they reach a
  service, and services throw `ApiError(status, message)` for expected failures.
- **Money moves in transactions.** Anything that spends or grants runs in `db.transaction()` and locks the accounts
  involved with `db.lockUsers()` (always in id order). Grants are keyed (a match id, a request id, a day), so a retry
  never pays twice.
- **SQL stays in repositories.** The TypeORM repository API, and parameterized SQL only where it cannot express the
  statement (upserts with arithmetic, aggregates).

## Rooms and HTTP API

| Room            | Purpose                                                                                                                       |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `matchmaking`   | one room per queue; players (or whole parties) search here and get a seat in a `party` room                                  |
| `party`         | a public match: the lobby, the rounds of a playlist and the results. Takes `input`, `ready`, `team`, `chat`...               |
| `party_private` | the same match in a lobby created by a player; others join by invitation or from the open room list (`GET /api/rooms`)      |
| `squad`         | a party of friends in the menu (`ready`, `kick`, `play`, `cancel`...); the leader's `play` sends everyone to `matchmaking` |

| HTTP prefix                                         | Purpose                                                                     |
| --------------------------------------------------- | --------------------------------------------------------------------------- |
| `/api/account`                                      | guest sign-in, sign-up, upgrade, profile, name, avatar, account deletion    |
| `/api/social`, `/api/rooms`                         | friends, blocks, invitations, the open room list                            |
| `/api/progression`, `/api/season`, `/api/events`    | missions and achievements, the battle pass, timed events                    |
| `/api/gacha`, `/api/store`                          | the character collection and the real-money store                           |
| `/api/reports`                                      | player reports (rate limited, with the reported player's recent chat)       |
| `/api/admin/*`, `/gm`                               | the GM console and its API (off until `PARTY_ADMIN_KEY` is set)             |
| `/health`, `/ready`, `/api/service/status`          | operations                                                                  |

Every route is mounted in `src/app/http.ts`; each module's `*.routes.ts` documents its requests and answers.

## Extending

**An HTTP feature.** Add `src/modules/<feature>/` with a repository, a service and a routes file, build them in
`app/container.ts` and mount the router in `app/http.ts`. New tables need an entity in
`infrastructure/database/entities/` and a new migration.

**A skill, hazard or course field.** Each kind is one file in `modules/match/simulation/skills/`, `hazards/` or
`fields/`, registered in that folder's `index.ts`, with a C# twin of the same name in the Unity project
(`Core/Simulation/Skills/`, `Hazards/` or `Fields/`). The kind validates its own content fields. Add it to a course in
Unity, export, and play it online and offline: when the two sides disagree, your runner jumps back where the kind
acts on it.

**A matchmaking rule.** Implement `MatchmakingRule` in `modules/matchmaking/matchmaking.rules.ts` (`admit` turns
tickets away, `compatible` decides who plays together), add its settings to `RuleSettings`, register it in
`RULE_FACTORIES` and validate the settings in `matchmaking.catalog.ts`. Queues opt in by listing it under `rules`.

**A room message.** Register it in `PartyRoom.registerMessages()`, handle it in the simulation and add the matching
send to the Unity `WebsocketBackend`. Unknown messages are ignored.

Before committing: `npm run format`, then `npm run typecheck`, `npm run lint` and `npm test`.

## GM console

Set `PARTY_ADMIN_KEY` and open `/gm`: a self-contained web page (no external requests, strict Content-Security-Policy)
for game masters, on top of the JSON API under `/api/admin`.

- Live overview and activity, live rooms (notice, kick, close) and the match chat.
- Players: search and filters, profile, economy, characters, battle pass, leaderboard cleanup, history.
- Moderation: player reports, bans and mutes. A ban refuses every sign-in and ends the account's sessions and seats; a
  mute drops the player's match chat.
- Bulk grants, purchases and revenue, leaderboards, the running content and the audit log.

Every change is written to `gm_actions` with the operator name and address, and grants carry a request id so a retry
pays once. Both `/gm` and `/api/admin` answer 404 until the key is set. `shared/admin-guard.ts` gates them: the
optional `PARTY_ADMIN_ALLOWED_IPS` allowlist, then a lockout after repeated wrong keys from one address, then the key
compared in constant time. Serve the console over HTTPS only.

## In-app purchases

Stars packs are listed in `game_config/party-store.json` and validated at startup. Amounts always come from that file,
never from the client.

- `GET /api/store` lists the packs (and what the player owns, with a session token).
- `GET /api/store/check?productId=` checks a purchase before paying and returns the `accountToken` to pass to the store
  (Apple `appAccountToken`, Google obfuscated account id).
- `POST /api/store/purchase` verifies the receipt with Google Play or the App Store and grants the pack once. Every
  delivered transaction is a row of `iap_transactions`, keyed by a hash of the store transaction, so a receipt pays
  once across all accounts. Xcode and local-testing transactions are never accepted.

| Variable                                                                   | Meaning                                                                                                          |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `PARTY_IAP_DEMO_PURCHASES`                                                 | `1` grants packs without payment (the catalog needs `demoPurchases: true` too). Default: on in development, off in production. |
| `PARTY_IAP_GOOGLE_SERVICE_ACCOUNT_FILE`, `PARTY_IAP_GOOGLE_SERVICE_ACCOUNT_JSON` | the Play Console service account key. Without it, Google purchases stay pending on the phone.             |
| `PARTY_IAP_APPLE_ROOT_CERTS_DIR`                                           | Apple root certificates (DER); default `certs/apple`, which ships with the public Apple Root CA G3              |
| `PARTY_IAP_APPLE_ONLINE_CHECKS`                                            | `1` (default) also checks certificate revocation with Apple (OCSP)                                               |

Never commit a service account key or a `.env` file: `.gitignore` already keeps `.env*` (except `.env.example`),
`data/`, `build/` and `node_modules/` out of Git.

## Documentation

The full template guide (Unity project, game data, the online backend, the GM console and an Ubuntu deployment
walkthrough) is online at https://bizachi-dev.gitbook.io/casual-party-games-template/. Support:
https://discord.com/invite/EGGj77g3eQ.

## License

[MIT](LICENSE). Copyright (c) 2026 BizachiCode.
