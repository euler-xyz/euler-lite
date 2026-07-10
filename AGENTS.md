# AGENTS.md

## Cursor Cloud specific instructions

Euler Lite is a single **Nuxt 4 / Vue 3 (TypeScript)** frontend for the Euler DeFi lending
protocol. There is one service: the Nuxt app (SSR server + client). Standard commands live in
`README.md` ("Available Scripts") and `package.json`.

### Node version
- The app requires **Node 24** (24.14.1 is installed via `nvm` and set as the default). The VM's
  system `node` at `/exec-daemon/node` is Node 22, so `~/.bashrc` prepends the Node 24 bin to
  `PATH`. New login shells already resolve `node -v` to 24.x — no action needed. If you spawn a
  non-login/non-interactive shell and get Node 22, run `nvm use default` or prepend
  `$HOME/.nvm/versions/node/v24.14.1/bin` to `PATH`.

### Environment config (`.env`)
- The app reads runtime config from `.env` (gitignored). A working dev `.env` is created during
  setup by copying `.env.example` and setting `NUXT_PUBLIC_APP_URL=http://localhost:3000` plus a
  public RPC: `RPC_URL_1=https://ethereum-rpc.publicnode.com`. If `.env` is missing, recreate it
  the same way — **at least one `RPC_URL_<chainId>` is required** or the chain selector shows no
  chains. Subgraph URLs for many chains are already present in `.env.example`.
- `NUXT_PUBLIC_APP_KIT_PROJECT_ID` (Reown/WalletConnect) is left empty; browsing/read flows work
  without it, but live wallet connection needs a real project ID.
- Enabled chains are derived from `RPC_URL_<chainId>` vars at server startup, so **restart
  `npm run dev` after editing chain env vars** (they are not hot-reloaded).

### Running / testing
- Dev server: `npm run dev` → http://localhost:3000 (use a tmux session so it persists).
- Vault/market data (Explore page, vault details) loads from the upstream V3 API + the configured
  RPC; some individual price/vault upstream calls may log `502`/timeout warnings without breaking
  the page.
- Lint: `npm run lint` (a few pre-existing `no-explicit-any` warnings, 0 errors).
- Typecheck: `npm run typecheck`.
- Tests: `npm run test:run` (single pass; `npm run test` is watch mode). Test runs print lots of
  `pino` warn/error JSON lines from exercised code paths — this is expected; check the final
  vitest summary.
- A `pre-commit` hook (simple-git-hooks + lint-staged) runs `eslint --fix` on staged files.
