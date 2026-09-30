# One image runs everything: the API, the dashboards (/app, /platform), the verify
# pages and the PDF worker. Settings come from the environment (see .env.example).
#
#   docker build -t doctrust .
#   docker run -p 3100:3100 --env-file .env doctrust

# ---- Build the dashboards ---------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app
# Chrome comes from the system package in the final image, not Puppeteer's download.
ENV PUPPETEER_SKIP_DOWNLOAD=true
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN npm ci
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN npm run build

# ---- Runtime ----------------------------------------------------------------------
FROM node:22-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium ca-certificates fonts-liberation fonts-dejavu-core fonts-noto-color-emoji \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    PORT=3100 \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    # Chrome's own sandbox needs kernel features containers usually don't allow.
    # Pages it renders are still limited to RENDER_ALLOWED_HOSTS.
    PUPPETEER_NO_SANDBOX=true
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN npm ci --omit=dev -w @doctrust/api && npm cache clean --force
COPY packages/shared packages/shared
COPY apps/api apps/api
COPY --from=build /app/apps/web/dist apps/web/dist

USER node
WORKDIR /app/apps/api
EXPOSE 3100
CMD ["node", "server.js"]
