#!/bin/sh
set -eu

if [ -z "${EULER_SDK_BRANCH:-}" ]; then
  echo "EULER_SDK_BRANCH is not set; using @eulerxyz/euler-v2-sdk from package-lock.json."
  npm ls @eulerxyz/euler-v2-sdk --depth=0
  exit 0
fi

SDK_REPO="${EULER_SDK_REPO:-https://github.com/euler-xyz/euler-sdks.git}"
SDK_DIR="/tmp/euler-sdks"
SDK_PACK_DIR="/tmp/euler-sdk-pack"

echo "Installing @eulerxyz/euler-v2-sdk from ${SDK_REPO} branch ${EULER_SDK_BRANCH}."

if ! command -v git >/dev/null 2>&1; then
  apt-get update
  apt-get install -y --no-install-recommends git ca-certificates
  rm -rf /var/lib/apt/lists/*
fi

rm -rf "$SDK_DIR" "$SDK_PACK_DIR"
git clone --filter=blob:none --depth=1 --branch "$EULER_SDK_BRANCH" "$SDK_REPO" "$SDK_DIR"

cd "$SDK_DIR"
SDK_PACKAGE_MANAGER="$(node -p "require('./package.json').packageManager || ''")"
SDK_PACKAGE_MANAGER_PACKAGE="${SDK_PACKAGE_MANAGER%%+*}"
SDK_PNPM_PACKAGE="pnpm@${EULER_SDK_PNPM_VERSION:-10}"

if [ -n "$SDK_PACKAGE_MANAGER_PACKAGE" ]; then
  case "$SDK_PACKAGE_MANAGER_PACKAGE" in
    pnpm@*|pnpm)
      SDK_PNPM_PACKAGE="$SDK_PACKAGE_MANAGER_PACKAGE"
      ;;
    *)
      echo "Unsupported SDK package manager: ${SDK_PACKAGE_MANAGER}" >&2
      exit 1
      ;;
  esac
fi

case "$SDK_PNPM_PACKAGE" in
  pnpm@*|pnpm)
    npm install --global "$SDK_PNPM_PACKAGE"
    ;;
  *)
    echo "Unsupported SDK pnpm package: ${SDK_PNPM_PACKAGE}" >&2
    exit 1
    ;;
esac

CI=true pnpm install --frozen-lockfile
if ! pnpm -C packages/euler-v2-sdk run build; then
  pnpm approve-builds --all || true
  pnpm -C packages/euler-v2-sdk run build
fi

mkdir -p "$SDK_PACK_DIR"
npm pack ./packages/euler-v2-sdk --pack-destination "$SDK_PACK_DIR"

cd /usr/src/app
npm install --no-save --package-lock=false --ignore-scripts "$SDK_PACK_DIR"/*.tgz
npm ls @eulerxyz/euler-v2-sdk --depth=0
