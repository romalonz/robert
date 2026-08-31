#!/usr/bin/env bash
# Robert — pull & run from source (macOS / Linux).
#   git clone <repo> && cd robert/pluely && ./setup.sh
# Installs the toolchain if missing, the JS deps, then builds & launches Robert.
set -euo pipefail
cd "$(dirname "$0")"
say(){ printf "\n\033[1;36m▶ %s\033[0m\n" "$*"; }

command -v node >/dev/null || { echo "Install Node.js 20+ from https://nodejs.org, then re-run."; exit 1; }
if ! command -v cargo >/dev/null; then
  say "Installing Rust (rustup)…"; curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
  . "$HOME/.cargo/env"
fi
if [[ "$OSTYPE" == linux* ]]; then
  say "Installing Linux WebKit/Tauri build deps (needs sudo)…"
  sudo apt-get update && sudo apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev patchelf libasound2-dev pkg-config build-essential || true
fi
say "Installing JS dependencies…"; npm install
say "Building & launching Robert (first build downloads Rust crates; give it a few minutes)…"
npm run tauri build
echo
echo "Built. The app is in src-tauri/target/release/bundle/  (open the .app / installer there)."
echo "Or run in dev mode:  npm run tauri dev"
