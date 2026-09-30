$ErrorActionPreference = 'Stop'
$node = (Get-Command node -ErrorAction Stop).Source
$nodeVersion = & $node --version
if ($LASTEXITCODE -ne 0 -or [version]($nodeVersion.Trim().TrimStart('v')) -lt [version]'22.13.0') { throw '需要 Node.js 22.13+' }
$root = Join-Path $env:USERPROFILE '.tokenrank'
if (-not (Test-Path (Join-Path $root 'config.json'))) { throw '尚未接入，请先执行小程序里的接入命令' }
if ((Get-Item -LiteralPath $root).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw '同步器目录不能是链接' }
$tmp = Join-Path $root ('update-' + [guid]::NewGuid().ToString('N'))
$stage = Join-Path $tmp 'stage'
New-Item -ItemType Directory -Path $stage -Force | Out-Null
try {
  Write-Host '下载更新工具，保留现有账号绑定…'
  Invoke-WebRequest -Uri 'https://tokenrank.xmasdong.cn/dl/tokenrank-client-0.2.9.tar.gz' -OutFile (Join-Path $tmp 'app.tar.gz') -UseBasicParsing -TimeoutSec 180
  tar -xzf (Join-Path $tmp 'app.tar.gz') -C $stage
  if ($LASTEXITCODE -ne 0) { throw '下载包解压失败，尚未更改原版' }
  $pkg = Get-Content (Join-Path $stage 'package.json') -Raw | ConvertFrom-Json
  if ($pkg.name -ne 'tokenrank-client' -or $pkg.version -ne '0.2.9') { throw '下载内容不是预期更新工具' }
  & $node --no-warnings (Join-Path $stage 'bin\tokenrank.js') update-and-resync
  if ($LASTEXITCODE -ne 0) { throw '更新或回传未完成，请处理上述错误后重试' }
} finally { Remove-Item -LiteralPath $tmp -Recurse -Force }
