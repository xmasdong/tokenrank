#!/bin/sh
# Ship only the independent adapter, excluding legacy scanner and writable Store.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DL="$ROOT/../server/public/dl"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT HUP INT TERM
mkdir -p "$DL" "$TMP/bin"
cp "$ROOT/bin/tokenrank.js" "$ROOT/bin/tokenwatcher.js" "$TMP/bin/"
cp -R "$ROOT/sync" "$ROOT/package.json" "$ROOT/README.md" "$ROOT/LICENSE" "$TMP/"
tar -czf "$DL/tokenrank-client.tar.gz" -C "$TMP" .
node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1])).version)' "$ROOT/package.json" > "$DL/version.txt"
VERSION=$(cat "$DL/version.txt")
cp "$DL/tokenrank-client.tar.gz" "$DL/tokenrank-client-$VERSION.tar.gz"
mkdir -p "$ROOT/../server/public/releases/$VERSION"
cp "$ROOT/../server/public/install.sh" "$ROOT/../server/public/install.ps1" "$ROOT/../server/public/update.sh" "$ROOT/../server/public/update.ps1" "$ROOT/../server/public/releases/$VERSION/"
echo "已打包独立同步器：$DL/tokenrank-client.tar.gz"
