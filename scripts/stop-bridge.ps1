# Stops the AI Civ Copilot bridge: whatever process listens on its port.

$port = if ($env:AICIV_PORT) { [int]$env:AICIV_PORT } else { 8737 }
$conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if (-not $conns) {
    Write-Output "No bridge is listening on port $port."
    exit 0
}
foreach ($c in $conns) {
    $proc = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
    if ($proc) {
        Stop-Process -Id $proc.Id -Force
        Write-Output "Stopped $($proc.ProcessName) (process $($proc.Id)) on port $port."
    }
}
