#!/bin/sh
# Reuse an existing original collector; bootstrap a missing dependency before sync.
set -eu
SERVER="${1:-}"; TOKEN="${2:-}"
[ -n "$SERVER" ] && [ -n "$TOKEN" ] || { echo '缺少服务器地址或接入码'; exit 1; }
command -v node >/dev/null 2>&1 || { echo '请先安装 Node.js 22.13+'; exit 1; }
node -e 'const [a,b]=process.versions.node.split(".").map(Number); if(a<22||(a===22&&b<13))process.exit(1)' || { echo '需要 Node.js 22.13+'; exit 1; }
node -e 'const u=new URL(process.argv[1]); if(u.protocol!=="https:"&&!(["localhost","127.0.0.1","[::1]"].includes(u.hostname)&&u.protocol==="http:"))process.exit(1); if(u.username||u.password||u.search||u.hash||!/^[0-9a-f]{32}$/.test(process.argv[2]))process.exit(1)' "$SERVER" "$TOKEN" || { echo '服务器地址或接入码无效'; exit 1; }
APP="$HOME/.tokenrank/app"
BIN_DIR="$HOME/.local/bin"
[ ! -L "$HOME/.tokenrank" ] && [ ! -L "$APP" ] || { echo '安装目录不能是符号链接'; exit 1; }
mkdir -p "$HOME/.tokenrank"
TMP=$(mktemp -d "$HOME/.tokenrank/install.XXXXXX")
trap 'rm -rf "$TMP"' EXIT HUP INT TERM
mkdir "$TMP/stage"
echo '下载接入程序，检查并准备原版 token-watcher…'
curl -fsSL "${SERVER%/}/dl/tokenrank-client-0.2.9.tar.gz" -o "$TMP/app.tar.gz"
tar -xzf "$TMP/app.tar.gz" -C "$TMP/stage"
node -e 'const p=require(process.argv[1]); if(p.name!=="tokenrank-client"||p.version!=="0.2.9")process.exit(1)' "$TMP/stage/package.json"
node --no-warnings "$TMP/stage/bin/tokenrank.js" prepare-upstream
node --no-warnings "$TMP/stage/bin/tokenrank.js" migrate-legacy-agent --app-root "$APP"
node --no-warnings "$TMP/stage/bin/tokenrank.js" start-upstream
node --no-warnings "$TMP/stage/bin/tokenrank.js" doctor
if [ -f "$APP/sync/agent.js" ]; then node --no-warnings "$APP/bin/tokenrank.js" uninstall-agent; fi
if [ -d "$APP" ]; then mv "$APP" "$HOME/.tokenrank/app-backup-$(date +%s)-$$"; fi
mv "$TMP/stage" "$APP"
mkdir -p "$BIN_DIR"
node -e 'const fs=require("fs");const quote=s=>"\x27"+s.replaceAll("\x27","\x27\\\x27\x27")+"\x27";fs.writeFileSync(process.argv[1],"#!/bin/sh\nexec "+quote(process.execPath)+" --no-warnings "+quote(process.argv[2])+" \"$@\"\n",{mode:0o755})' "$BIN_DIR/tokenrank" "$APP/bin/tokenrank.js"
chmod +x "$BIN_DIR/tokenrank"
if ! "$BIN_DIR/tokenrank" connect "$SERVER" "$TOKEN"; then
  echo '首次同步未完成。配置已保留，请检查网络或接入码；后台服务将重试。'
fi
"$BIN_DIR/tokenrank" install-agent
# An existing pre-fix original double counts; upgrade and rebuild before its usage is published.
if ! "$BIN_DIR/tokenrank" update-if-outdated; then
  echo '统计内核升级未完成，升级前不会上传用量。按上面的提示处理后运行：'
  echo "curl -fsSL ${SERVER%/}/update.sh | sh"
fi
echo "独立同步服务已安装。查看状态：$BIN_DIR/tokenrank rank status"
echo '原版负责采集，TokenRank 负责只读同步；统计内核保持在修复重复统计的版本以上。'
