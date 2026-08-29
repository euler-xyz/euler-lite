# ── Doppler CLI stage ──
FROM --platform=$BUILDPLATFORM node:24.14.1 AS doppler

ARG TARGETARCH
RUN set -eux; \
  case "$TARGETARCH" in \
    amd64) \
      DOPPLER_URL='https://github.com/DopplerHQ/cli/releases/download/3.76.0/doppler_3.76.0_linux_amd64.tar.gz'; \
      DOPPLER_SHA256='04f1ff30ed162d7af1dba7f11ad6a37ef35099de86a7ec6e261b64b1b337a3f3'; \
      ;; \
    arm64) \
      DOPPLER_URL='https://github.com/DopplerHQ/cli/releases/download/3.76.0/doppler_3.76.0_linux_arm64.tar.gz'; \
      DOPPLER_SHA256='ee57701385fc33fba550f913641812ed2ff020631e3ac8cc14616cbde2118884'; \
      ;; \
    *) \
      echo "Unsupported TARGETARCH: $TARGETARCH" >&2; \
      exit 1; \
      ;; \
  esac; \
  curl --fail --silent --show-error --location \
    --proto '=https' --proto-redir '=https' --tlsv1.2 --retry 3 \
    --output /tmp/doppler.tar.gz "$DOPPLER_URL"; \
  printf '%s  %s\n' "$DOPPLER_SHA256" /tmp/doppler.tar.gz | sha256sum --check --strict -; \
  tar --extract --gzip --file /tmp/doppler.tar.gz --directory /usr/local/bin doppler; \
  chmod 0755 /usr/local/bin/doppler

# ── Build stage ──
FROM node:24.14.1 AS builder

WORKDIR /usr/src/app
COPY package.json package-lock.json ./
RUN npm ci

# Preview SDK branches are mutable. Including the Lite source snapshot in this
# layer key makes each Lite revision resolve the current remote branch head.
COPY . .
ARG EULER_SDK_BRANCH
ARG EULER_SDK_PNPM_VERSION=10
RUN chmod +x scripts/install-preview-sdk.sh && scripts/install-preview-sdk.sh

ENV NODE_OPTIONS=--max-old-space-size=4096

RUN npm run build

# ── Production stage (distroless: no shell, no tools, non-root) ──
FROM gcr.io/distroless/nodejs24-debian12:nonroot AS production

ENV MODE=production
ENV NODE_ENV=production
ENV HOST=0.0.0.0

ARG APP_PORT=3000
ENV PORT=${APP_PORT}

ARG NETWORK=mainnet
ENV NETWORK=${NETWORK}

WORKDIR /usr/src/app

# Copy only the built output and the verified Doppler binary
COPY --from=builder /usr/src/app/.output .output
COPY --from=doppler /usr/local/bin/doppler ./doppler

EXPOSE ${APP_PORT}

# Liveness probe: /healthz lives outside /api/ so it is exempt from the
# geo-gate, rate limiting, and internal-request authentication — the probe
# must not depend on edge configuration (EDGE_PROVIDER / EDGE_ORIGIN_SECRET)
# and must never carry the origin secret in its arguments.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://localhost:'+process.env.PORT+'/healthz').then(r=>{if(!r.ok)throw r.status}).catch(()=>process.exit(1))"]

# Doppler injects all secrets at runtime via DOPPLER_TOKEN, DOPPLER_PROJECT, DOPPLER_CONFIG env vars.
# server/plugins/chain-config.ts scans env vars and injects chain config via render:html hook.
#
# ENTRYPOINT [] overrides distroless default (/nodejs/bin/node) so Doppler
# can be the primary process. Doppler must be a statically linked binary
# since distroless has no shell or dynamic linker beyond what Node needs.
# Verify with: docker run --rm <image> ./doppler --version
ENTRYPOINT []
CMD ["./doppler", "run", "--", "/nodejs/bin/node", ".output/server/index.mjs"]
