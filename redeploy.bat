@echo off
chcp 65001 >nul
setlocal
title qq-farm-bot 部署

rem 统一 Python 的编码行为，避免中文在 cmd 窗口乱码
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"

rem 优先用带 paramiko 的隔离环境，找不到再退回系统 python
set "PY=C:\Users\Administrator\.workbuddy\binaries\python\envs\default\Scripts\python.exe"
if not exist "%PY%" set "PY=python"

cd /d "%~dp0"

rem 带参数时跳过菜单，保持命令行用法兼容
if not "%~1"=="" goto with_args

:menu
cls
echo ======================================================
echo   qq-farm-bot  部署方式
echo ======================================================
echo.
echo   [1]  全量部署      拉代码 + 构建镜像 + 重启 + 验证
echo                      ^> 常规上线，有缓存约 5-8 分钟
echo.
echo   [2]  快速上线      跳过构建，直接重启 + 验证
echo                      ^> 镜像已是最新时用，秒级完成
echo.
echo   [3]  预构建        只在服务器建镜像，不重启
echo                      ^> 避开高峰：先建好，闲时用 [2] 秒上线
echo.
echo   [4]  无缓存重建    丢掉构建缓存全量重来
echo                      ^> 依赖升级或构建结果异常时用，约 20 分钟
echo.
echo   [5]  仅健康检查    不动代码、不动镜像、不重启
echo   [6]  显示帮助
echo   [0]  退出
echo.
set "PICK="
set /p "PICK=请输入序号 [1]: "
if not defined PICK set "PICK=1"
echo %PICK%| findstr /r "^[0-6]$" >nul || goto menu

if "%PICK%"=="0" exit /b 0
if "%PICK%"=="6" goto show_help

set "ARGS="
if "%PICK%"=="2" set "ARGS=--skip-build"
if "%PICK%"=="3" set "ARGS=--build-only"
if "%PICK%"=="4" set "ARGS=--no-cache"
if "%PICK%"=="5" set "ARGS=--verify-only"
goto run

:with_args
if "%~1"=="--help" goto show_help
if "%~1"=="-h" goto show_help
set "ARGS=%*"
goto run

:show_help
echo.
"%PY%" "scripts\deploy\redeploy.py" --help
echo.
pause
goto menu

:run
echo.
echo ------------------------------------------------------
"%PY%" "scripts\deploy\redeploy.py" %ARGS%
set "RC=%ERRORLEVEL%"

echo.
echo ------------------------------------------------------
if "%RC%"=="0" (
  echo [成功] 已完成。
  echo        重启类操作后，账号需到面板手动点「启动」。
) else (
  echo [失败] 退出码 %RC%
  echo        服务器日志: /tmp/redeploy-current.log
  echo        可以跑:    redeploy.bat --attach  接着看进度
)
echo.
pause
exit /b %RC%
