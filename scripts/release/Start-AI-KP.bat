@echo off
chcp 65001 >nul
cd /d "%~dp0"
title AI KP

where node >nul 2>nul
if errorlevel 1 goto nonode

node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)"
if errorlevel 1 goto oldnode

echo.
echo   AI KP 正在启动，稍后会自动打开浏览器：http://127.0.0.1:3100
echo   第一次使用需要的"管理令牌"在本文件夹的 data\admin-token.txt 里。
echo   玩的时候不要关闭这个窗口；关闭窗口就会停止 AI KP。
echo.
start "" cmd /c "timeout /t 2 >nul & start http://127.0.0.1:3100"
node --env-file-if-exists=.env --disable-warning=ExperimentalWarning dist\src\platform\server.js
echo.
echo   AI KP 已停止。如果上面有报错，可以截图后反馈。
pause
exit /b 0

:nonode
echo.
echo   没有找到 Node.js。
echo   请先打开 https://nodejs.org 下载并安装 LTS 版（22.13 或更高），装好后再双击本文件。
echo.
start "" https://nodejs.org
pause
exit /b 1

:oldnode
echo.
echo   你的 Node.js 版本太旧，需要 22.13 或更高。
echo   请到 https://nodejs.org 下载安装最新的 LTS 版，然后再双击本文件。
echo.
start "" https://nodejs.org
pause
exit /b 1
