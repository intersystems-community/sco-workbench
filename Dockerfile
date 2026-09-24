# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# SCO Workbench — single image bundling the Node.js backend (Claude Agent SDK
# agent) and the built frontend chat UI. The @intersystems/intersystems-iris-native
# dependency installs from public npm with prebuilt Linux binaries (no compile).
#
# IMPORTANT: everything runs on Ubuntu 24.04 + Node 22 (matches .nvmrc):
#   - IRIS Native selects its binary by Linux distro; Ubuntu resolves the
#     correct lnxubuntu2404{arch} build (Debian would fall back to a RHEL x64
#     binary — wrong on arm64).
#   - Native addons (better-sqlite3) are installed against this exact Node ABI,
#     so the base is shared across the deps and runtime stages to avoid a
#     NODE_MODULE_VERSION mismatch.
# ---------------------------------------------------------------------------

# ---- Base: Ubuntu 24.04 + Node 22 ----
FROM ubuntu:24.04 AS base
ENV DEBIAN_FRONTEND=noninteractive
# Install Node 22 (active LTS; matches .nvmrc) from the official nodejs.org
# tarball (bundles npm). Ubuntu 24.04 is required so the IRIS Native package
# resolves its lnxubuntu2404{arch} prebuilt binary; the glibc it was built
# against matches this base.
ARG NODE_VERSION=22.20.0
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl xz-utils \
 && arch="$(dpkg --print-architecture)" \
 && case "$arch" in \
      amd64) nodearch=x64 ;; \
      arm64) nodearch=arm64 ;; \
      *) echo "unsupported arch: $arch" && exit 1 ;; \
    esac \
 && curl -fsSLo /tmp/node.tar.xz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${nodearch}.tar.xz" \
 && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 --exclude CHANGELOG.md --exclude LICENSE --exclude README.md \
 && rm /tmp/node.tar.xz \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/* \
 && node -v && npm -v
WORKDIR /app

# ---- Stage 1: install all deps (workspaces) ----
FROM base AS deps
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN npm ci

# ---- Stage 2: build frontend + backend (+ compile the JDBC helpers) ----
FROM deps AS build
# JDK to compile the tiny JDBC helpers (test + schema introspection). They only
# use java.sql.* (drivers are loaded at RUNTIME by class name), so no driver JAR
# is needed to compile them.
RUN apt-get update \
 && apt-get install -y --no-install-recommends default-jdk-headless \
 && apt-get clean && rm -rf /var/lib/apt/lists/*
COPY . .
RUN npm run build --workspace @sco-workbench/frontend \
 && npm run build --workspace @sco-workbench/backend \
 && javac backend/jdbc-helper/*.java

# ---- Stage 3: production dependencies only ----
FROM base AS prod-deps
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
# Install prod deps for all workspaces (frontend has only devDeps, so --omit=dev
# skips them). This reliably populates the hoisted root node_modules.
RUN npm ci --omit=dev \
 # Trim the IRIS Native package's multi-platform binaries (~450MB) to the two
 # Ubuntu 24.04 targets the runtime image can resolve (x64 + arm64).
 && find node_modules/@intersystems/intersystems-iris-native/bin -mindepth 1 -maxdepth 1 -type d \
      ! -name 'lnxubuntu2404x64' ! -name 'lnxubuntu2404arm64' \
      -exec rm -rf {} + || true

# ---- Stage 4: runtime ----
FROM base AS runtime
ENV NODE_ENV=production
ENV SQLITE_PATH=/data/workbench.sqlite
ENV PORT=3000
# JRE for the JDBC "Test Connection" helper (real JDBC via a spawned JVM). The
# JDBC driver JAR(s) are baked in below and put on the classpath at JDBC_LIB_DIR.
ENV JDBC_LIB_DIR=/app/backend/jdbc-lib
RUN apt-get update \
 && apt-get install -y --no-install-recommends default-jre-headless \
 && apt-get clean && rm -rf /var/lib/apt/lists/*

# Production node_modules (native addons built against this same Node ABI).
# Most deps hoist to the root; native modules (better-sqlite3) stay under the
# workspace's own node_modules, so copy both.
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/backend/node_modules ./backend/node_modules
# Compiled backend + skills
COPY --from=build /app/backend/dist ./backend/dist
COPY --from=build /app/backend/.claude ./backend/.claude
COPY backend/package.json ./backend/package.json
# JDBC test helper: the compiled .class from the build stage + the driver JAR(s)
# from the build context (baked in). Together they satisfy JDBC_LIB_DIR + the
# helper classpath the backend spawns.
COPY --from=build /app/backend/jdbc-helper ./backend/jdbc-helper
COPY backend/jdbc-lib ./backend/jdbc-lib
# Built Angular frontend served statically by the backend (resolved as ../public
# from dist/). The @angular/build application builder emits to dist/browser.
COPY --from=build /app/frontend/dist/browser ./backend/public
# Example data sets for the "Load example data" page. Baked in, not mounted: without
# them the page can only say "no example data sets available", which is the container
# behaving worse than a dev checkout for no reason. The path matters — the backend
# resolves its default set directory three levels above the running module
# (dist/util/ -> /app), so the folder has to sit BESIDE backend/ exactly as it does in
# the repo. Point SAMPLE_DATA_DIR at a mounted volume to use different sets instead.
COPY SampleData ./SampleData

VOLUME ["/data"]
EXPOSE 3000
WORKDIR /app/backend
CMD ["node", "dist/index.js"]
