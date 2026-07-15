@echo off
chcp 65001 >nul
title 天罡日程 2.0
cd /d %~dp0
rem 已在运行则只开浏览器
powershell -NoProfile -Command "try{(Invoke-WebRequest -Uri http://localhost:8790 -UseBasicParsing -TimeoutSec 2)|Out-Null;exit 0}catch{exit 1}" >nul 2>&1
if %errorlevel%==0 (
  echo 服务已在运行,直接打开浏览器…
  start "" http://localhost:8790
  exit /b 0
)
start "" http://localhost:8790
echo 天罡日程 2.0 启动中… 关闭本窗口即停止服务
node server.js
pause
