FROM node:20-bookworm-slim AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:20-bookworm-slim AS runner

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Browser-based marketplace scanning (Stagehand env=LOCAL) launches Chromium via
# chrome-launcher, which discovers the binary through CHROME_PATH / `which` and
# does NOT use Playwright or PLAYWRIGHT_BROWSERS_PATH. Install a system Chromium
# (pulls its own runtime libs) and pin CHROME_PATH so the launched binary is
# deterministic. Runs as root here, before `USER node`; /usr/bin is world-readable.
RUN apt-get update \
    && apt-get install -y --no-install-recommends chromium fonts-liberation \
    && rm -rf /var/lib/apt/lists/*
ENV CHROME_PATH=/usr/bin/chromium

COPY --from=builder /app/dist ./dist

USER node

EXPOSE 3000

CMD ["node", "dist/main.js"]
