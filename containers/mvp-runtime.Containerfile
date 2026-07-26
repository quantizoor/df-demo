ARG RUNTIME_BASE_IMAGE=docker.io/library/python@sha256:d50fb7611f86d04a3b0471b46d7557818d88983fc3136726336b2a4c657aa30b
FROM --platform=linux/amd64 ${RUNTIME_BASE_IMAGE}

ARG RUNTIME_BASE_IMAGE
ARG SOURCE_COMMIT=unknown
ARG DEBIAN_SNAPSHOT=20260725T000000Z

LABEL org.opencontainers.image.title="ParallaxAI dark-factory MVP runtime substrate" \
      org.opencontainers.image.description="Pinned linux/amd64 glibc substrate for isolated dark-factory optimizer and evaluator roles" \
      org.opencontainers.image.source="https://github.com/parallaxai/ParallaxAI" \
      org.opencontainers.image.revision="${SOURCE_COMMIT}" \
      org.opencontainers.image.licenses="Proprietary"

ENV DEBIAN_FRONTEND=noninteractive \
    HARBOR_TELEMETRY=off \
    DISABLE_AUTOUPDATER=1 \
    DISABLE_UPDATES=1 \
    HOME=/home/dark-factory \
    PATH=/usr/local/bin:/usr/bin:/bin

COPY containers/mvp-runtime-pins.json /usr/local/share/dark-factory/mvp-runtime-pins.json

RUN set -eux; \
    pins=/usr/local/share/dark-factory/mvp-runtime-pins.json; \
    expected_base="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["runtimeBaseImage"])' "${pins}")"; \
    expected_snapshot="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["debianSnapshot"])' "${pins}")"; \
    expected_uid="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["defaultUser"]["uid"])' "${pins}")"; \
    expected_gid="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["defaultUser"]["gid"])' "${pins}")"; \
    expected_user="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["defaultUser"]["name"])' "${pins}")"; \
    test "${RUNTIME_BASE_IMAGE}" = "${expected_base}"; \
    test "${DEBIAN_SNAPSHOT}" = "${expected_snapshot}"; \
    test "${expected_uid}" = "10001"; \
    test "${expected_gid}" = "10001"; \
    test "${expected_user}" = "dark-factory"; \
    test "$(uname -m)" = "x86_64"; \
    getconf GNU_LIBC_VERSION | grep -Eq '^glibc '; \
    rm -f /etc/apt/sources.list /etc/apt/sources.list.d/debian.sources; \
    printf '%s\n' \
      "deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT}/ bookworm main" \
      "deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT}/ bookworm-updates main" \
      "deb [check-valid-until=no] https://snapshot.debian.org/archive/debian-security/${DEBIAN_SNAPSHOT}/ bookworm-security main" \
      > /etc/apt/sources.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      bash \
      build-essential \
      ca-certificates \
      coreutils \
      curl \
      file \
      findutils \
      git \
      gzip \
      libgcc-s1 \
      libstdc++6 \
      passwd \
      pkg-config \
      procps \
      tar \
      unzip \
      xz-utils; \
    rm -rf /var/lib/apt/lists/*; \
    test -z "$(awk -F: '$3 == 65532 || $3 == 65533 { print $3 }' /etc/passwd /etc/group)"; \
    ! getent passwd 10001; \
    ! getent group 10001; \
    test -x /usr/sbin/groupadd; \
    test -x /usr/sbin/useradd; \
    /usr/sbin/groupadd --gid 10001 dark-factory; \
    /usr/sbin/useradd --uid 10001 --gid 10001 --create-home --home-dir /home/dark-factory --shell /bin/bash dark-factory; \
    test -x /usr/local/bin/python3; \
    ln -sfn /usr/local/bin/python3 /usr/bin/python3; \
    install -d -o 10001 -g 10001 -m 0755 \
      /workspace \
      /workspace/df-state \
      /trusted \
      /artifacts

RUN set -eux; \
    pins=/usr/local/share/dark-factory/mvp-runtime-pins.json; \
    version="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["node"]["version"])' "${pins}")"; \
    npm_version="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["node"]["npmVersion"])' "${pins}")"; \
    url="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["node"]["url"])' "${pins}")"; \
    sha256="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["node"]["archiveSha256"])' "${pins}")"; \
    curl --fail --silent --show-error --location "${url}" --output /tmp/node.tar.xz; \
    echo "${sha256}  /tmp/node.tar.xz" | sha256sum --check --strict; \
    tar --no-same-owner -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1; \
    rm /tmp/node.tar.xz; \
    ln -sfn /usr/local/bin/node /usr/bin/node; \
    ln -sfn /usr/local/bin/npm /usr/bin/npm; \
    ln -sfn /usr/local/bin/corepack /usr/bin/corepack; \
    test "$(stat -Lc '%u:%g' /usr/local/bin/node)" = "0:0"; \
    test "$(node --version)" = "v${version}"; \
    test "$(npm --version)" = "${npm_version}"

RUN set -eux; \
    pins=/usr/local/share/dark-factory/mvp-runtime-pins.json; \
    version="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["bun"]["version"])' "${pins}")"; \
    url="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["bun"]["url"])' "${pins}")"; \
    sha256="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["bun"]["archiveSha256"])' "${pins}")"; \
    variant="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["bun"]["variant"])' "${pins}")"; \
    curl --fail --silent --show-error --location "${url}" --output /tmp/bun.zip; \
    echo "${sha256}  /tmp/bun.zip" | sha256sum --check --strict; \
    unzip -q /tmp/bun.zip -d /tmp/bun; \
    install -m 0755 "/tmp/bun/${variant}/bun" /usr/local/bin/bun; \
    rm -rf /tmp/bun /tmp/bun.zip; \
    test "$(bun --version)" = "${version}"

RUN set -eux; \
    pins=/usr/local/share/dark-factory/mvp-runtime-pins.json; \
    version="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["claudeCode"]["version"])' "${pins}")"; \
    url="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["claudeCode"]["url"])' "${pins}")"; \
    sha256="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["claudeCode"]["archiveSha256"])' "${pins}")"; \
    install -d /tmp/claude; \
    curl --fail --silent --show-error --location "${url}" --output /tmp/claude.tar.gz; \
    echo "${sha256}  /tmp/claude.tar.gz" | sha256sum --check --strict; \
    tar -xzf /tmp/claude.tar.gz -C /tmp/claude; \
    test -f /tmp/claude/claude; \
    install -m 0755 /tmp/claude/claude /usr/local/bin/claude; \
    rm -rf /tmp/claude /tmp/claude.tar.gz; \
    test "$(claude --version | awk '{print $1}')" = "${version}"

RUN set -eux; \
    pins=/usr/local/share/dark-factory/mvp-runtime-pins.json; \
    version="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["harbor"]["version"])' "${pins}")"; \
    wheel_url="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["harbor"]["wheelUrl"])' "${pins}")"; \
    sha256="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["harbor"]["wheelSha256"])' "${pins}")"; \
    extra="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["harbor"]["extra"])' "${pins}")"; \
    wheel="/tmp/harbor-${version}-py3-none-any.whl"; \
    curl --fail --silent --show-error --location "${wheel_url}" --output "${wheel}"; \
    echo "${sha256}  ${wheel}" | sha256sum --check --strict; \
    python3 -m pip install \
      --disable-pip-version-check \
      --no-cache-dir \
      --only-binary=:all: \
      --index-url https://pypi.org/simple \
      "harbor[${extra}] @ file://${wheel}"; \
    rm "${wheel}"; \
    test "$(python3 -c 'import importlib.metadata; print(importlib.metadata.version("harbor"))')" = "${version}"; \
    python3 -c 'import daytona'; \
    test -x /usr/local/bin/harbor

RUN set -eux; \
    pins=/usr/local/share/dark-factory/mvp-runtime-pins.json; \
    python3 -c 'import json,os,sys; d=json.load(open(sys.argv[1])); missing=[p for p in d["requiredExecutables"] if not (os.path.isfile(p) and os.access(p, os.X_OK))]; assert not missing, f"missing executables: {missing}"' "${pins}"; \
    test "$(id -u dark-factory)" = "10001"; \
    test "$(id -g dark-factory)" = "10001"; \
    test -z "$(awk -F: '$3 == 65532 || $3 == 65533 { print $3 }' /etc/passwd /etc/group)"; \
    test -z "$(find / -xdev \( -uid 65532 -o -uid 65533 -o -gid 65532 -o -gid 65533 \) -print -quit 2>/dev/null)"; \
    chown -R 10001:10001 /home/dark-factory /workspace /trusted /artifacts

WORKDIR /workspace
USER 10001:10001

RUN set -eux; \
    node --version; \
    npm --version; \
    corepack --version; \
    bun --version; \
    claude --version; \
    harbor --version

CMD ["/usr/local/bin/node", "-e", "setInterval(() => {}, 2147483647)"]
