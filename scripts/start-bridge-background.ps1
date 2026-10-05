# Starts the AI Civ Copilot bridge as its own hidden process, logging to
# companion\data\bridge.log (errors to bridge.err.log). It keeps running after
# the window or tool session that started it is gone. Stop it with
# scripts\stop-bridge.ps1. If a bridge already answers on the port, nothing
# new is started.

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$port = if ($env:AICIV_PORT) { [int]$env:AICIV_PORT } else { 8737 }

$existing = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($existing) {
    Write-Output "A bridge is already listening on port $port (process $($existing.OwningProcess)). Nothing started."
    exit 0
}

$data = Join-Path $repo 'companion\data'
$log = Join-Path $data 'bridge.log'
$err = Join-Path $data 'bridge.err.log'
foreach ($f in @($log, $err)) {
    if (Test-Path $f) { Move-Item -Force $f "$f.1" }
}

$p = Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -PassThru `
    -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'start-bridge.ps1')) `
    -RedirectStandardOutput $log -RedirectStandardError $err
Write-Output "Bridge started (process $($p.Id)). Log: $log"
