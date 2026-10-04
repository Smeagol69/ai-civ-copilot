@echo off
rem Double-click to start the AI Civ Copilot bridge. Leave this window open
rem while you play; the in-game panel shows "Connected" once it is running.
title AI Civ Copilot bridge
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-bridge.ps1"
pause
