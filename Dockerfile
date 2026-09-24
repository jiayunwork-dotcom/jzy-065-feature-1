# syntax=docker/dockerfile:1

# ---------- build ----------
FROM node:20-bookworm-slim AS build
WORKDIR /app

# Install deps against the lockfile first for better layer caching.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.test.json vitest.config.ts ./
COPY src ./src

# Type-check and compile.
RUN npm run build

# Unit + HTTP tests run as part of the image build. PG integration tests are
# skipped here (no database during build); the compose `tests` service runs
# the full suite with PostgreSQL available.
RUN npm test

# ---------- test runner (compose profile "tests") ----------
FROM build AS test
ENV NODE_ENV=test
CMD ["npm", "test"]

# ---------- runtime ----------
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV STORE=postgres
ENV PGHOST=db \
    PGPORT=5432 \
    PGUSER=webster \
    PGPASSWORD=webster \
    PGDATABASE=webster_timing \
    PORT=8080

# Production node modules + compiled app only.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

EXPOSE 8080
CMD ["node", "dist/server.js"]
