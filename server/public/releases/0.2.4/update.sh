#!/bin/sh
# Explicit maintenance for an already connected computer. No account token in this command.
set -eu
command -v node >/dev/null 2>&1 || { echo '请先安装 Node.js 22.13+'; exit 1; }
node -e 'const [a,b]=process.versions.node.split(".").map(Number); if(a<22||(a===22&&b<13))process.exit(1)' || { echo '需要 Node.js 22.13+'; exit 1; }
[ -f "$HOME/.tokenrank/config.json" ] || { echo '尚未接入，请先执行小程序里的接入命令'; exit 1; }
[ ! -L "$HOME/.tokenrank" ] || { echo '同步器目录不能是符号链接'; exit 1; }
TMP=$(mktemp -d "$HOME/.tokenrank/update.XXXXXX")
trap 'rm -rf "$TMP"' EXIT HUP INT TERM
mkdir "$TMP/stage"
echo '下载更新工具，保留现有账号绑定…'
curl --connect-timeout 20 --max-time 180 -fsSL https://tokenrank.xmasdong.cn/dl/tokenrank-client-0.2.4.tar.gz -o "$TMP/app.tar.gz"
tar -xzf "$TMP/app.tar.gz" -C "$TMP/stage"
node -e 'const p=require(process.argv[1]); if(p.name!=="tokenrank-client"||p.version!=="0.2.4")process.exit(1)' "$TMP/stage/package.json"
node --no-warnings "$TMP/stage/bin/tokenrank.js" update-and-resync
