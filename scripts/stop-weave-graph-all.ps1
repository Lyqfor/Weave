# 文件作用：停止 start-weave-graph-all.ps1 启动的三服务进程。

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = "D:/Agent/dagent"
$pidFile = Join-Path $repoRoot "scripts/.weave-graph-dev-pids.json"

if (-not (Test-Path $pidFile)) {
  Write-Host "[info] 未找到 PID 文件: $pidFile"
  exit 0
}

$state = Get-Content $pidFile -Raw | ConvertFrom-Json
$targets = @($state.graphServerPid, $state.graphWebPid, $state.cliPid)

foreach ($pid in $targets) {
  if (-not $pid) {
    continue
  }

  try {
    Stop-Process -Id ([int]$pid) -Force -ErrorAction Stop
    Write-Host "[ok] 已停止进程 PID=$pid"
  } catch {
    Write-Host "[warn] 停止进程失败或已退出 PID=$pid"
  }
}

Remove-Item $pidFile -Force
Write-Host "[done] 已清理 PID 文件"
