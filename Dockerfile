# ── Build stage 
FROM node:20.12.2 AS builder

WORKDIR /usr/src/app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# Download Doppler CLI (binary only, no package manager install)
RUN (curl -Ls --tlsv1.2 --proto "=https" --retry 3 https://cli.doppler.com/install.sh || wget -t 3 -qO- https://cli.doppler.com/install.sh) | sh -s -- --no-package-manager --no-install

# ── Production stage (distroless: no shell, no tools, non-root) ──
FROM gcr.io/distroless/nodejs20-debian12:nonroot AS production

ENV MODE=production
ENV NODE_ENV=production
ENV HOST=0.0.0.0

ARG APP_PORT=3000
ENV PORT=${APP_PORT}

ARG NETWORK=mainnet
ENV NETWORK=${NETWORK}

WORKDIR /usr/src/app

# Copy only the built output and Doppler binary from builder
COPY --from=builder /usr/src/app/.output .output
COPY --from=builder /usr/src/app/doppler ./doppler

EXPOSE ${APP_PORT}

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://localhost:'+process.env.PORT+'/api/tenderly/status').then(r=>{if(!r.ok)throw r.status}).catch(()=>process.exit(1))"]

# Doppler injects all secrets at runtime via DOPPLER_TOKEN, DOPPLER_PROJECT, DOPPLER_CONFIG env vars.
# server/plugins/chain-config.ts scans env vars and injects chain config via render:html hook.
#
# ENTRYPOINT [] overrides distroless default (/nodejs/bin/node) so Doppler
# can be the primary process. Doppler must be a statically linked binary
# since distroless has no shell or dynamic linker beyond what Node needs.
# Verify with: docker run --rm <image> ./doppler --version
ENTRYPOINT ["./doppler", "run", "--"]
CMD ["/nodejs/bin/node", ".output/server/index.mjs"]
