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
COPYFILE_DISABLE=1 tar -czf "$DL/tokenrank-client.tar.gz" -C "$TMP" .
node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1])).version)' "$ROOT/package.json" > "$DL/version.txt"
VERSION=$(cat "$DL/version.txt")
cp "$DL/tokenrank-client.tar.gz" "$DL/tokenrank-client-$VERSION.tar.gz"
mkdir -p "$ROOT/../server/public/releases/$VERSION"
cp "$ROOT/../server/public/install.sh" "$ROOT/../server/public/install.ps1" "$ROOT/../server/public/update.sh" "$ROOT/../server/public/update.ps1" "$ROOT/../server/public/releases/$VERSION/"
# Mirror the official Windows zstd for dsh sessions; the client pins the same SHA-256 (sync/zstd-check.js).
ZSTD_EXE="$DL/zstd-1.5.7-win64.exe"
if [ ! -f "$ZSTD_EXE" ]; then
  curl -fsSL https://github.com/facebook/zstd/releases/download/v1.5.7/zstd-v1.5.7-win64.zip -o "$TMP/zstd.zip"
  echo "acb4e8111511749dc7a3ebedca9b04190e37a17afeb73f55d4425dbf0b90fad9  $TMP/zstd.zip" | shasum -a 256 -c - >/dev/null
  unzip -p "$TMP/zstd.zip" zstd-v1.5.7-win64/zstd.exe > "$ZSTD_EXE"
fi
echo "8076aae03feac7c66b319579e82172eed168deed2a3f25e5e2d3c60f55e84111  $ZSTD_EXE" | shasum -a 256 -c - >/dev/null
[ -f "$DL/zstd-LICENSE.txt" ] || curl -fsSL https://raw.githubusercontent.com/facebook/zstd/v1.5.7/LICENSE -o "$DL/zstd-LICENSE.txt"
echo "已打包独立同步器：$DL/tokenrank-client.tar.gz"
