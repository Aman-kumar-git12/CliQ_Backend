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

## Project layout

```
src/
├── app.js             server setup: security, CORS, routes, sockets, status page
├── config/            index.js is the ONLY place that reads environment variables; redisClient.js
├── routes/            URL → controller mapping, one file per area
├── controllers/       request handlers, one folder per feature (auth/, posts/, chat/, ...)
├── middlewares/       authentication, input validation, the central error handler
├── utils/             helpers, one folder per feature matching controllers/; logger.js is shared
├── socket/            Socket.IO events
└── upload/            Cloudinary and multer setup
prisma/                schema.prisma and the seed script
```

## Conventions

- **Settings:** `const { config } = require("../config")`. Never read `process.env` elsewhere (ESLint enforces it).
- **Logging:** `const logger = require("../../utils/logger")` (from a controller) with `logger.debug/info/warn/error`. No `console` (ESLint enforces it). `LOG_LEVEL=debug` shows the detailed Smart Connections logs.
- **Errors:** every error response is `{ message }`. Anything a route throws or passes to `next(err)` reaches `middlewares/errorHandler.js`, which logs it and hides internals for 5xx errors. Unknown routes return a JSON 404.
- **Style:** 4-space indent, double quotes, semicolons, 120 columns (Prettier).

Before every commit:

```bash
npm run check          # ESLint + Prettier check
npm run lint:fix       # auto-fix what ESLint can
npm run format         # apply Prettier
```
