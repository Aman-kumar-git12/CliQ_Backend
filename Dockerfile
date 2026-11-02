# CliQ API server. Build: docker build -t cliq-backend .   Run: docker run --env-file .env -p 2004:2004 cliq-backend
FROM node:22-slim AS deps
WORKDIR /app
# Prisma's engines need OpenSSL
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./
# Full install so the Prisma CLI can generate the client, then drop the dev tools
# generate only reads the schema; the placeholder URL satisfies prisma.config.ts
RUN npm ci --ignore-scripts && DATABASE_URL=mongodb://localhost/build npx prisma generate && npm prune --omit=dev

FROM node:22-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json prisma.config.ts ./
COPY prisma ./prisma
COPY src ./src
USER node
EXPOSE 2004
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://localhost:'+(process.env.PORT||2004)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/app.js"]
