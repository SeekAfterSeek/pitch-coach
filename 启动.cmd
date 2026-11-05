@echo off
chcp 65001 >nul
title PitchCoach 练唱音准教练
cd /d "%~dp0"
echo.
echo   🎤 正在启动 PitchCoach ...
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   [错误] 没找到 Node.js
  echo.
  echo   请先安装 Node.js: https://nodejs.org/
  echo   安装后重新双击这个文件。
  echo.
  pause
  exit /b 1
)

node server.mjs %*
if errorlevel 1 pause
