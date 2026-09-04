#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
SOURCE_DIR="$ROOT_DIR/apps/extension/.output/firefox-mv2"

if [ ! -f "$SOURCE_DIR/manifest.json" ]; then
  echo "Firefox extension is not built. Run: pnpm build:firefox" >&2
  exit 1
fi

if [ "$(uname -s)" = "Linux" ] && [ -d "$HOME/snap/firefox/common" ]; then
  DEST_DIR="$HOME/snap/firefox/common/kavrith-extension-current"
  rm -rf "$DEST_DIR"
  mkdir -p "$DEST_DIR"
  cp -R "$SOURCE_DIR"/. "$DEST_DIR"/
  echo "Staged Firefox extension for Snap:"
  echo "$DEST_DIR/manifest.json"
  exit 0
fi

echo "Firefox extension manifest:"
echo "$SOURCE_DIR/manifest.json"
