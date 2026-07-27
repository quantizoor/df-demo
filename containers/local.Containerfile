# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=docker.io/library/node:24-bookworm-slim

FROM ${NODE_IMAGE} AS build

ENV CI=true
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.build.json ./

RUN corepack enable \
    && corepack prepare pnpm@11.9.0 --activate \
    && test "$(pnpm --version)" = "11.9.0" \
    && pnpm install --frozen-lockfile --ignore-scripts

COPY src ./src

RUN pnpm exec tsc -p tsconfig.build.json \
    && test -f /app/dist/local/cli.js \
    && pnpm prune --prod --ignore-scripts

FROM ${NODE_IMAGE} AS runtime

ENV NODE_ENV=production \
    HOME=/home/node
WORKDIR /app

COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist

RUN mkdir -p /data \
    && chown node:node /data

USER node:node
VOLUME ["/data"]

ENTRYPOINT ["node", "/app/dist/local/cli.js"]
CMD ["run", "--state-root", "/data"]
