# Installs the AI Civ Copilot on this machine:
#   1. copies the in-game panel mod into Civ VI's Mods folder
#   2. turns on the FireTuner socket (EnableTuner 1), backing up AppOptions.txt
#   3. installs the bridge's Node dependencies
# Re-run any time; it is idempotent. Close Civ VI first so it does not
# overwrite AppOptions.txt on exit.

param(
    [switch]$SkipTuner,
    [switch]$SkipNpm
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot

$modsDir = Join-Path $env:USERPROFILE "Documents\My Games\Sid Meier's Civilization VI\Mods"
$modSrc = Join-Path $repo 'mod\AICivCopilot'
$modDst = Join-Path $modsDir 'AICivCopilot'
New-Item -ItemType Directory -Force $modsDir | Out-Null
if (Test-Path $modDst) { Remove-Item -Recurse -Force $modDst }
Copy-Item -Recurse $modSrc $modDst
Write-Host "Mod installed: $modDst"

if (-not $SkipTuner) {
    if (Get-Process -Name 'CivilizationVI*' -ErrorAction SilentlyContinue) {
        Write-Warning 'Civ VI is running. It may overwrite AppOptions.txt when it exits; re-run this after closing it.'
    }
    $opts = Join-Path $env:LOCALAPPDATA "Firaxis Games\Sid Meier's Civilization VI\AppOptions.txt"
    if (Test-Path $opts) {
        $text = Get-Content -Raw -Path $opts
        if ($text -match '(?m)^\s*EnableTuner\s+1\s*$') {
            Write-Host 'FireTuner already enabled.'
        } else {
            $backup = "$opts.bak-aiciv"
            if (-not (Test-Path $backup)) { Copy-Item $opts $backup; Write-Host "Backed up AppOptions.txt to $backup" }
            if ($text -match '(?m)^\s*EnableTuner\s+\d+') {
                $text = [regex]::Replace($text, '(?m)^(\s*)EnableTuner\s+\d+', '${1}EnableTuner 1')
            } else {
                $text = $text.TrimEnd() + "`r`n;Enable FireTuner.`r`nEnableTuner 1`r`n"
            }
            [System.IO.File]::WriteAllText($opts, $text, (New-Object System.Text.UTF8Encoding($false)))
            Write-Host 'FireTuner enabled (EnableTuner 1). The tuner listens on 127.0.0.1:4318 only.'
        }
    } else {
        Write-Warning "AppOptions.txt not found at $opts - start Civ VI once, then re-run."
    }
}

if (-not $SkipNpm) {
    Push-Location (Join-Path $repo 'companion')
    try { npm install --no-audit --no-fund } finally { Pop-Location }
}

Write-Host ''
Write-Host 'Next:'
Write-Host '  1. Start the bridge:   scripts\start-bridge.ps1'
Write-Host '  2. Launch Civ VI, enable "AI Civ Copilot" under Additional Content, load a game.'
Write-Host '  3. In game press Ctrl+Shift+A (or the AI button) and ask.'
