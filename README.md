# CliQ Backend

Express API for CliQ: auth, profiles, posts, connections, chat, notifications, search and the routes
that proxy to the Python AI agent (`WebsiteAgent`). Data lives in MongoDB through Prisma; Redis caches
recommendations and presence; Socket.IO pushes chat messages and notifications.

## Setup

```bash
npm install                # also runs `prisma generate`
cp .env.example .env       # then fill in the required values
npm run dev                # http://localhost:2004, restarts on changes
```

`npm start` runs without auto-restart (production).

- **API reference:** http://localhost:2004/api/docs (Swagger UI), generated from the routes and their
  validation schemas; the raw OpenAPI document is at `/api/docs/openapi.json`.
- **Health:** `/api/health` (process up) and `/api/health/ready` (database reachable; use this one
  for uptime monitoring).
- **Whole stack in Docker:** `docker compose up --build` starts MongoDB, Redis, the agent, this API
  and the frontend with a local database (see `docker-compose.yml`).

## Tests

```bash
npm test               # Jest + Supertest against a throwaway in-memory MongoDB
```

Tests never touch the real database: `tests/helpers/env.js` sets every variable before the app loads,
emails are captured instead of sent, and the AI agent is pointed at a closed port. The first run
downloads a MongoDB binary (about 100 MB).

## Project layout

```
src/
├── app.js             starts the server: sockets, status page, self-ping, crash handling
├── createApp.js       the Express app: middleware order, health checks, API docs, routes, errors
├── config/            index.js is the ONLY place that reads environment variables; redisClient.js
├── routes/            URL → controller mapping, one file per area
├── controllers/       request handlers, one folder per feature (auth/, posts/, chat/, ...)
├── middlewares/       authentication, validate() (zod), rate limits + origin check, the error handler
├── validation/        schemas.js: the shape of every request body and query string
├── docs/              OpenAPI document generated from the routes
├── utils/             helpers, one folder per feature matching controllers/; logger.js is shared
├── socket/            Socket.IO events
└── upload/            Cloudinary and multer setup
prisma/                schema.prisma and the seed script
tests/                 API tests; helpers/ starts the in-memory database
```

## Conventions

- **Settings:** `const { config } = require("../config")`. Never read `process.env` elsewhere (ESLint enforces it).
- **Logging:** `const logger = require("../../utils/logger")` (from a controller) with `logger.debug/info/warn/error`. No `console` (ESLint enforces it). `LOG_LEVEL=debug` shows the detailed Smart Connections logs.
- **Input:** add a zod schema to `src/validation/schemas.js` and put `validate({ body, query })` on the
  route. The controller then receives the parsed body (trimmed, lower-cased emails, defaults applied),
  and the API docs pick the schema up automatically.
- **Errors:** every error response is `{ message, code?, errors? }` (`code` such as `VALIDATION_ERROR`,
  `TOKEN_EXPIRED`, `OTP_LOCKED`, `RATE_LIMITED`; `errors` lists each invalid field). Anything a route throws or passes to `next(err)` reaches `middlewares/errorHandler.js`, which logs it and hides internals for 5xx errors. Unknown routes return a JSON 404.
- **Style:** 4-space indent, double quotes, semicolons, 120 columns (Prettier).

Before every commit:

```bash
npm run check          # ESLint + Prettier check + tests
npm run lint:fix       # auto-fix what ESLint can
npm run format         # apply Prettier
```

## Sessions and security

- **Sessions:** `/login` sets two httpOnly cookies: `auth_token` (a JWT valid 15 minutes) and
  `refresh_token` (random, stored hashed in `RefreshToken`, sent only to `/auth/*`). A sign-in lasts 7 days
  from login (`SESSION_TTL_DAYS`); renewals keep that end date.
  A request with an expired token gets `401 { code: "TOKEN_EXPIRED" }`; the frontend then calls
  `POST /auth/refresh`, which swaps the refresh token for a new one. Replaying an already-used
  refresh token whose replacement was already used ends every session in its family; one whose
  replacement was never used (the browser lost the renewal response, e.g. during a restart) is renewed again. A password or email change ends all sessions.
- **Codes:** emailed 6-digit codes expire after 10 minutes and are deleted after 5 wrong guesses.
- **Rate limits** (`middlewares/security.js`): every route per IP, auth routes per IP and per email,
  AI routes per minute. They count in memory, which is right for one instance; several instances
  need a shared store such as `rate-limit-redis`.
- **Cross-site requests:** in production the cookies are `SameSite=None` (site and API are on
  different domains), so changing requests from a browser must carry an allowed `Origin`.
- **Monitoring:** set `SENTRY_DSN` to report errors to Sentry; logs are JSON lines in production and
  every line and response carries an `X-Request-Id`, which is also forwarded to the AI agent.

## Get Connections without waiting

Opening Get Connections never waits for ranking or for the AI agent (which may be asleep on Render):

1. **Embeddings are computed once.** The agent saves each profile's embedding in the `profile_embeddings`
   collection (packed float32, ~1.5 KB per user) and loads them all at startup, so a restart re-embeds
   nobody. A profile is embedded again only when its content changes.
2. **Each user's ranked list is stored.** Ranking runs in the background (after login, after changes) and
   saves the top results to `RecommendationList` as ids, scores and reasons only (~1 KB per user). A
   request reads that list (Redis keeps a 3-minute hot copy in front of it), loads the profiles to show,
   and filters out anyone already connected, requested or skipped.
3. **Changes mark the list stale instead of deleting it.** A profile edit, connection or feedback sets
   `staleAt`; the old list is still shown immediately and re-ranked in the background. Lists older than
   6 hours are refreshed the same way. Only a brand-new user with no list yet gets the quick "seed" picks
   while their first ranking runs.

See `SECURITY.md` for secret rotation and deployment notes.
