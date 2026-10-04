# Starts the AI Civ Copilot bridge in this window.
# The Anthropic key is a user-level environment variable on this machine and
# is not always present in tool or IDE sessions, so read it explicitly.
# The value is never printed.

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot

if (-not $env:ANTHROPIC_API_KEY) {
    $k = [Environment]::GetEnvironmentVariable('ANTHROPIC_API_KEY', 'User')
    if ($k) { $env:ANTHROPIC_API_KEY = $k }
}
if (-not $env:ANTHROPIC_API_KEY) {
    Write-Warning 'ANTHROPIC_API_KEY is not set. The bridge will start, but questions will fail until it is.'
}

Push-Location (Join-Path $repo 'companion')
try { node server.mjs } finally { Pop-Location }
