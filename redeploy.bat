@echo off
chcp 65001 >nul
setlocal
title qq-farm-bot 一键部署
cd /d "%~dp0"

rem 统一 Python 的编码行为，避免中文在 cmd 窗口乱码
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"

rem 优先用带 paramiko 的隔离环境，找不到再退回系统 python
set "PY=C:\Users\Administrator\.workbuddy\binaries\python\envs\default\Scripts\python.exe"
if not exist "%PY%" set "PY=python"

echo ==================================================
echo   qq-farm-bot 一键部署
echo   本机 git pull --^> 服务器拉代码 --^> 构建 --^> 重启 --^> 验证
echo.
echo   无参数        全流程部署
echo   --skip-build  不重建镜像，只重启 + 验证
echo   --verify-only 只做健康检查
echo   --no-pull     本机不拉代码
echo   --attach      接着看上次没跑完的进度
echo ==================================================
echo.

"%PY%" "scripts\deploy\redeploy.py" %*
set "RC=%ERRORLEVEL%"

echo.
if "%RC%"=="0" (
  echo [成功] 部署完成。别忘了到面板手动点「启动」账号。
) else (
  echo [失败] 退出码 %RC%，详见服务器 /tmp/redeploy-current.log
)
echo.
pause
