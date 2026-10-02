param([Parameter(Mandatory=$true)][string]$Server, [Parameter(Mandatory=$true)][string]$Token)
$ErrorActionPreference = 'Stop'
$node = (Get-Command node -ErrorAction Stop).Source
function Run-Node { & $node @args; if ($LASTEXITCODE -ne 0) { throw '同步器检查或操作失败，请按提示处理后重试' } }
$nodeVersion = & $node --version
if ($LASTEXITCODE -ne 0 -or [version]($nodeVersion.Trim().TrimStart('v')) -lt [version]'22.13.0') { throw '需要 Node.js 22.13+' }
if ($Token -cnotmatch '^[0-9a-f]{32}$') { throw '接入码无效' }
$uri = [uri]$Server
if ($uri.Scheme -ne 'https' -and -not ($uri.Scheme -eq 'http' -and $uri.IsLoopback)) { throw '服务器需使用 HTTPS' }
if ($uri.UserInfo -or $uri.Query -or $uri.Fragment) { throw '服务器地址不能包含凭据或参数' }
$root = Join-Path $env:USERPROFILE '.tokenrank'
$app = Join-Path $root 'app'
foreach ($p in @($root, $app)) {
  if ((Test-Path $p) -and ((Get-Item -LiteralPath $p).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw '安装目录不能是链接' }
}
New-Item -ItemType Directory -Force -Path $root | Out-Null
$tmp = Join-Path $root ('install-' + [guid]::NewGuid().ToString('N'))
$stage = Join-Path $tmp 'stage'
New-Item -ItemType Directory -Path $stage -Force | Out-Null
try {
  Write-Host '下载接入程序，检查并准备原版 token-watcher…'
  Invoke-WebRequest -Uri ($Server.TrimEnd('/') + '/dl/tokenrank-client-0.2.11.tar.gz') -OutFile (Join-Path $tmp 'app.tar.gz') -UseBasicParsing
  tar -xzf (Join-Path $tmp 'app.tar.gz') -C $stage
  if ($LASTEXITCODE -ne 0) { throw '解压失败，旧版本尚未替换' }
  $pkg = Get-Content (Join-Path $stage 'package.json') -Raw | ConvertFrom-Json
  if ($pkg.name -ne 'tokenrank-client' -or $pkg.version -ne '0.2.11') { throw '下载内容不是预期的独立同步器' }
  $entry = Join-Path $stage 'bin\tokenrank.js'
  Run-Node --no-warnings $entry prepare-upstream
  Run-Node --no-warnings $entry migrate-legacy-agent --app-root $app
  Run-Node --no-warnings $entry start-upstream
  Run-Node --no-warnings $entry doctor
  if (Test-Path (Join-Path $app 'sync\agent.js')) { Run-Node --no-warnings (Join-Path $app 'bin\tokenrank.js') uninstall-agent }
  if (Test-Path $app) { Move-Item -LiteralPath $app -Destination (Join-Path $root ('app-backup-' + [guid]::NewGuid().ToString('N'))) }
  Move-Item -LiteralPath $stage -Destination $app
  $entry = Join-Path $app 'bin\tokenrank.js'
  $binDir = Join-Path $root 'bin'
  New-Item -ItemType Directory -Force -Path $binDir | Out-Null
  $shim = "@echo off`r`nchcp 65001 >nul`r`n`"$node`" --no-warnings `"%~dp0..\app\bin\tokenrank.js`" %*`r`n"
  [IO.File]::WriteAllText((Join-Path $binDir 'tokenrank.cmd'), $shim, (New-Object Text.UTF8Encoding $false))
  & $node --no-warnings $entry connect $Server $Token
  if ($LASTEXITCODE -ne 0) { Write-Warning '首次同步未完成，配置已保留。检查网络或接入码；后台服务将重试。' }
  Run-Node --no-warnings $entry install-agent
  & $node --no-warnings $entry update-if-outdated
  if ($LASTEXITCODE -ne 0) { throw ('统计内核检查或升级未完成。按上面的提示处理后重新运行：& ([scriptblock]::Create((irm ''' + $Server.TrimEnd('/') + '/update.ps1'')))') }
  Write-Host "独立同步服务已安装。可把 $binDir 加入 PATH。"
  Write-Host '原版负责采集，TokenRank 负责只读同步；已检查统计内核最新稳定版。'
} finally { Remove-Item -LiteralPath $tmp -Recurse -Force }
