@echo off
chcp 65001 >nul
title qq-farm-bot 一键部署
cd /d "%~dp0"

set PY=C:\Users\Administrator\.workbuddy\binaries\python\envs\default\Scripts\python.exe
if not exist "%PY%" set PY=python

echo ============================================
echo   qq-farm-bot 一键部署
echo   本机 git pull ^> 服务器拉代码 ^> 构建镜像 ^> 重启 ^> 验证
echo ============================================
echo.

"%PY%" "scripts\deploy\redeploy.py" %*
set RC=%ERRORLEVEL%

echo.
if "%RC%"=="0" (
  echo [成功] 部署完成，别忘了到面板手动点「启动」账号。
) else (
  echo [失败] 退出码 %RC%，检查上面输出和 /tmp/redeploy-*.log
)
echo.
pause
