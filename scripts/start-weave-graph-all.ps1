# 文件作用：一键启动主 CLI、图后端、图前端三服务，并自动注入图转发环境变量。

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = "D:/Agent/dagent"
$graphServerDir = Join-Path $repoRoot "apps/weave-graph-server"
$graphWebDir = Join-Path $repoRoot "apps/weave-graph-web"
$logPath = Join-Path $graphServerDir ".run.log"
$pidFile = Join-Path $repoRoot "scripts/.weave-graph-dev-pids.json"

if (Test-Path $logPath) {
  Remove-Item $logPath -Force
}

Write-Host "[start] 启动图后端..."
$graphServerProc = Start-Process -FilePath "powershell" -ArgumentList @(
  "-NoExit",
  "-Command",
  "Set-Location '$graphServerDir'; pnpm dev *> .run.log"
) -PassThru

$token = ""
$port = ""
$deadline = (Get-Date).AddSeconds(20)

while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 300
  if (-not (Test-Path $logPath)) {
    continue
  }

  $content = Get-Content $logPath -Raw
  if ($content -match "ingest=http://127\.0\.0\.1:(\d+)/ingest/runtime-event token=([a-f0-9]+)") {
    $port = $Matches[1]
    $token = $Matches[2]
    break
  }
}

if (-not $port -or -not $token) {
  throw "图后端启动超时：未能在日志中解析 port/token，请检查 $logPath"
}

$ingestUrl = "http://127.0.0.1:$port/ingest/runtime-event"
$graphWebUrl = "http://127.0.0.1:5173/?port=$port&token=$token"

Write-Host "[ok] 图后端已启动: ingest=$ingestUrl"

Write-Host "[start] 启动图前端..."
$graphWebProc = Start-Process -FilePath "powershell" -ArgumentList @(
  "-NoExit",
  "-Command",
  "Set-Location '$graphWebDir'; pnpm dev"
) -PassThru

Write-Host "[start] 启动主 CLI (带图转发环境变量)..."
$cliProc = Start-Process -FilePath "powershell" -ArgumentList @(
  "-NoExit",
  "-Command",
  "Set-Location '$repoRoot'; `$env:WEAVE_GRAPH_INGEST_URL='$ingestUrl'; `$env:WEAVE_GRAPH_TOKEN='$token'; pnpm dev"
) -PassThru

$pids = @{
  graphServerPid = $graphServerProc.Id
  graphWebPid = $graphWebProc.Id
  cliPid = $cliProc.Id
  ingestUrl = $ingestUrl
  graphWebUrl = $graphWebUrl
  token = $token
  startedAt = (Get-Date).ToString("o")
}

$pids | ConvertTo-Json -Depth 5 | Set-Content -Path $pidFile -Encoding UTF8

Write-Host ""
Write-Host "[done] 三服务已启动"
Write-Host "- 图前端地址: $graphWebUrl"
Write-Host "- 图后端日志: $logPath"
Write-Host "- PID 信息: $pidFile"
