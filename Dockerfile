FROM node:22.23.3-bookworm-slim AS base
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.33.2 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/context-engine/package.json ./packages/context-engine/package.json
COPY packages/context-adapters/package.json ./packages/context-adapters/package.json

FROM base AS build
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.web.json vite.config.ts ./
COPY web ./web
COPY shared ./shared
COPY public ./public
RUN pnpm build:client

FROM base AS production-deps
RUN pnpm install --prod --frozen-lockfile --ignore-scripts

FROM node:22.23.3-bookworm-slim AS runtime
WORKDIR /app
ARG REVISION=local
LABEL org.opencontainers.image.revision=$REVISION
COPY --from=production-deps /app/node_modules ./node_modules
COPY --from=production-deps /app/packages ./packages
COPY package.json server.ts ./
COPY packages ./packages
COPY src ./src
COPY shared ./shared
COPY migrations ./migrations
COPY public ./public
COPY --from=build /app/public/build ./public/build
COPY scripts/database ./scripts/database
COPY scripts/deploy/container-health.mjs ./scripts/deploy/container-health.mjs
RUN mkdir -p /app/.workflow-data /var/lib/auto-workflow/runtime /var/lib/auto-workflow/tenants /var/lib/auto-workflow/workspace \
    && chown -R node:node /app/.workflow-data /var/lib/auto-workflow
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4173 DATABASE_PATH=/var/lib/auto-workflow/workflow.sqlite TENANT_ENV_DIR=/var/lib/auto-workflow/tenants
USER node
EXPOSE 4173
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=3 CMD ["node", "scripts/deploy/container-health.mjs"]
CMD ["node", "--env-file-if-exists=/run/config/auto-workflow.env", "--import", "tsx", "--import", "./src/issueSources/preload.ts", "server.ts"]
