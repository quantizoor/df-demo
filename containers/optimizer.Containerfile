# syntax=docker/dockerfile:1.7

ARG ROLE_BASE_IMAGE
FROM ${ROLE_BASE_IMAGE} AS build

ARG SOURCE_COMMIT
ARG CLAUDE_CODE_VERSION
ARG HARBOR_VERSION

USER root
WORKDIR /build
ENV CI=true \
    DF_CLOUD_EXECUTION=1

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.build.json biome.json vitest.config.ts ./
COPY src ./src
COPY scripts ./scripts
COPY claude-plugin ./claude-plugin

RUN test -x /usr/local/bin/node \
    && corepack enable \
    && corepack prepare pnpm@11.9.0 --activate \
    && test "$(pnpm --version)" = "11.9.0" \
    && pnpm install --frozen-lockfile --ignore-scripts \
    && pnpm build \
    && pnpm prune --prod

FROM ${ROLE_BASE_IMAGE} AS runtime

ARG SOURCE_COMMIT
ARG CLAUDE_CODE_VERSION
ARG HARBOR_VERSION

LABEL org.opencontainers.image.source="https://github.com/quantizoor/df-demo" \
      org.opencontainers.image.revision="${SOURCE_COMMIT}" \
      io.parallaxai.dark-factory.role="optimizer" \
      io.parallaxai.dark-factory.claude-code-version="${CLAUDE_CODE_VERSION}" \
      io.parallaxai.dark-factory.harbor-version="${HARBOR_VERSION}"

USER root
RUN test -x /usr/local/bin/node \
    && command -v git >/dev/null \
    && test -n "${CLAUDE_CODE_VERSION}" \
    && npm install --global --ignore-scripts --no-audit --no-fund \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
    && node -e 'const m=require("/usr/local/lib/node_modules/@anthropic-ai/claude-code/package.json"); if (m.version !== process.argv[1]) process.exit(78)' "${CLAUDE_CODE_VERSION}" \
    && test -x /usr/local/bin/claude \
    && mkdir -p /app /workspace /trusted /home/dark-factory \
    && chown -R 65532:65532 /app /workspace /trusted /home/dark-factory

COPY --from=build --chown=65532:65532 /build/package.json /app/package.json
COPY --from=build --chown=65532:65532 /build/node_modules /app/node_modules
COPY --from=build --chown=65532:65532 /build/dist /app/dist
COPY --from=build --chown=65532:65532 /build/scripts /app/scripts
COPY --from=build --chown=65532:65532 /build/claude-plugin /app/claude-plugin

USER 65532:65532
ENV HOME=/home/dark-factory \
    NODE_ENV=production
WORKDIR /workspace
CMD ["/usr/local/bin/node", "-e", "setInterval(()=>{},2147483647)"]
