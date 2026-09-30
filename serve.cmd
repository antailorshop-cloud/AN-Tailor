@echo off
title AN TAILOR - local dev server
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve.ps1" -Port 8080
pause
