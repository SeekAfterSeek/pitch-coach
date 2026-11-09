@echo off
chcp 65001 >nul
title 人声对比工作室
cd /d "%~dp0"
echo.
echo   🎙️ 正在启动「人声对比工作室」...
echo   启动后在浏览器打开 http://127.0.0.1:8756/
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
