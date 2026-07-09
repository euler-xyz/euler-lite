#!/bin/sh
set -eu

if [ -z "${EULER_SDK_BRANCH:-}" ]; then
  echo "EULER_SDK_BRANCH is not set; using @eulerxyz/euler-v2-sdk from package-lock.json."
  npm ls @eulerxyz/euler-v2-sdk --depth=0
  exit 0
fi

case "$EULER_SDK_BRANCH" in
  -*|*..*|*//*|*[!A-Za-z0-9._/-]*)
    echo "Unsupported EULER_SDK_BRANCH value: ${EULER_SDK_BRANCH}" >&2
    exit 1
    ;;
esac

APP_SDK_VERSION="$(node -p "const p=require('/usr/src/app/package.json'); const spec=(p.dependencies||{})['@eulerxyz/euler-v2-sdk'] || (p.devDependencies||{})['@eulerxyz/euler-v2-sdk'] || ''; spec.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/)?.[0] || ''")"

SDK_REPO="https://github.com/euler-xyz/euler-sdks.git"
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
if [ -n "$APP_SDK_VERSION" ]; then
  SDK_RELEASE_TAG="euler-v2-sdk-v${APP_SDK_VERSION}"
  if git fetch --quiet --depth=1000 origin "refs/tags/${SDK_RELEASE_TAG}:refs/tags/${SDK_RELEASE_TAG}" 2>/dev/null; then
    SDK_RELEASE_COMMIT="$(git rev-parse "refs/tags/${SDK_RELEASE_TAG}^{}")"
    if git merge-base --is-ancestor HEAD "$SDK_RELEASE_COMMIT"; then
      echo "SDK branch ${EULER_SDK_BRANCH} is already included in ${SDK_RELEASE_TAG}; using @eulerxyz/euler-v2-sdk from package-lock.json."
      cd /usr/src/app
      npm ls @eulerxyz/euler-v2-sdk --depth=0
      exit 0
    fi
  else
    echo "Pinned SDK tag ${SDK_RELEASE_TAG} was not found; continuing with preview SDK branch."
  fi
fi

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

node - <<'NODE'
const fs = require('node:fs')

const packageJsonPath = 'packages/euler-v2-sdk/package.json'
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))
const appPackageJson = JSON.parse(fs.readFileSync('/usr/src/app/package.json', 'utf8'))
const appSdkSpec = appPackageJson.dependencies?.['@eulerxyz/euler-v2-sdk']
  || appPackageJson.devDependencies?.['@eulerxyz/euler-v2-sdk']
  || ''
const appPinnedVersion = appSdkSpec.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/)?.[0]

if (!packageJson.name) {
  throw new Error(`${packageJsonPath} is missing a package name`)
}

const targetVersion = appPinnedVersion || process.env.EULER_SDK_PREVIEW_VERSION || packageJson.version || '0.0.0-preview.0'
if (packageJson.version !== targetVersion) {
  packageJson.version = targetVersion
  fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`)
  console.log(`Stamped preview package version ${packageJson.version} into ${packageJsonPath}.`)
}
NODE

mkdir -p "$SDK_PACK_DIR"
npm pack --ignore-scripts ./packages/euler-v2-sdk --pack-destination "$SDK_PACK_DIR"

cd /usr/src/app
npm install --no-save --package-lock=false --ignore-scripts "$SDK_PACK_DIR"/*.tgz
if ! npm ls @eulerxyz/euler-v2-sdk --depth=0; then
  echo "npm ls reported a version mismatch for the preview SDK tarball; validating runtime exports instead."
fi

node --input-type=module - <<'NODE'
import { buildEulerSDK, PositionMigrationService } from '@eulerxyz/euler-v2-sdk'

const missing = []
if (typeof buildEulerSDK !== 'function') missing.push('buildEulerSDK')
if (typeof PositionMigrationService !== 'function') missing.push('PositionMigrationService')

if (missing.length > 0) {
  throw new Error(`Preview SDK is missing expected exports: ${missing.join(', ')}`)
}

console.log('Preview @eulerxyz/euler-v2-sdk migration exports are available.')
NODE
