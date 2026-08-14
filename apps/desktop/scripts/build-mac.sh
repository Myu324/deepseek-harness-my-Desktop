#!/usr/bin/env bash
# One-shot macOS artifact build for the DeepSeek Harness desktop shell:
# clones the repository when needed, installs dependencies, builds the shell,
# and assembles the unsigned dmg + zip into apps/desktop/.artifacts/.
#
# Usage (from anywhere, incl. via curl):
#   bash apps/desktop/scripts/build-mac.sh          # inside the repository
#   bash <(curl -fsSL https://raw.githubusercontent.com/Myu324/deepseek-harness-my-Desktop/master/apps/desktop/scripts/build-mac.sh)
#
# In China, speed up the Electron download by prefixing either invocation with:
#   ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ bash ...
#
# The artifacts are unsigned: Gatekeeper will ask recipients to right-click →
# Open on first launch. Signing + notarization need an Apple Developer
# certificate — see apps/desktop/README.md § macOS.
set -euo pipefail

# Keep in sync with the repository root's packageManager field.
PNPM_VERSION='11.7.0'
REPO_URL="${DSH_MAC_REPO_URL:-https://github.com/Myu324/deepseek-harness-my-Desktop.git}"
REPO_BRANCH="${DSH_MAC_REPO_BRANCH:-master}"

echo '==> Checking platform'
if [[ "$(uname -s)" != 'Darwin' ]]; then
  echo 'error: this script assembles the macOS artifacts and must run on macOS.' >&2
  exit 1
fi

echo '==> Checking prerequisites'
if ! command -v git >/dev/null 2>&1; then
  echo 'error: git is missing — install the command line tools with: xcode-select --install' >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo 'error: node is missing — install Node 24 (or 22.19+), e.g.: brew install node@24' >&2
  exit 1
fi
node_major="$(node -p 'process.versions.node.split(".")[0]')"
if [[ "${node_major}" -lt 22 ]]; then
  echo "error: node ${node_major} is too old; the repository needs Node ^22.19 or >=24" >&2
  exit 1
fi

echo '==> Preparing pnpm'
if ! command -v pnpm >/dev/null 2>&1; then
  # Fails with npm's own permission error when the global prefix is root-owned.
  npm install --global "pnpm@${PNPM_VERSION}"
fi

echo '==> Fetching the repository'
if [[ -f 'package.json' ]] && grep -q '"@deepseek-ai/dsh-root"' package.json 2>/dev/null; then
  REPO_DIR="$(pwd)"
  echo "using the repository at ${REPO_DIR}"
else
  REPO_DIR="$(pwd)/deepseek-harness"
  if [[ -d "${REPO_DIR}/.git" ]]; then
    git -C "${REPO_DIR}" fetch --tags origin
    git -C "${REPO_DIR}" checkout "${REPO_BRANCH}"
    git -C "${REPO_DIR}" pull --ff-only
  else
    git clone --depth 1 --branch "${REPO_BRANCH}" "${REPO_URL}" "${REPO_DIR}"
  fi
fi

echo '==> Installing dependencies'
cd "${REPO_DIR}"
pnpm install --frozen-lockfile

echo '==> Building the desktop shell'
pnpm --filter @deepseek-ai/dsh-desktop run build

echo '==> Assembling the dmg and zip (unsigned)'
CSC_IDENTITY_AUTO_DISCOVERY=false pnpm --filter @deepseek-ai/dsh-desktop run pack:mac

ARTIFACTS="${REPO_DIR}/apps/desktop/.artifacts"
echo
echo 'Done. Artifacts:'
ls -lh "${ARTIFACTS}"/*.dmg "${ARTIFACTS}"/*.zip
echo
echo 'Send the .dmg to macOS users. It is unsigned: on first launch, recipients'
echo 'right-click → Open (or run: xattr -d com.apple.quarantine "<the app>").'
echo 'First launch downloads the engine (a few minutes, network required).'
