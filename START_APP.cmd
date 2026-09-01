@echo off
title SFXFS Transcriber
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start_app.ps1"
if errorlevel 1 (
  echo.
  echo Launch failed. Details: work\launcher.log
  pause
)
