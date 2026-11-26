# 部署脚本

把最新代码部署到服务器：本机同步 → 服务器拉码 → 构建镜像 → 重启容器 → 端到端验证。

## 快速开始

```bash
# 1. 装依赖（只需一次）
pip install paramiko

# 2. 填配置（复制模板，改成你自己的服务器）
cp scripts/deploy/.deploy.env.example scripts/deploy/.deploy.env
#   .deploy.env 已被 .gitignore 排除，不会进版本库

# 3. 一条命令部署
python scripts/deploy/redeploy.py
```

Windows 上也可以直接双击仓库根目录的 `redeploy.bat`。

## 参数

| 参数 | 作用 |
|---|---|
| （无） | 全流程：本机同步 `GIT_REMOTE/BRANCH` → 服务器拉码 → 构建 → 重启 → 验证 |
| `--no-pull` | 本机不拉代码，只部署服务器 |
| `--skip-build` | 服务器不重建镜像，只重启容器 + 验证（改配置时用，约 20 秒） |
| `--verify-only` | 只做健康检查和端到端验证（约 20 秒） |
| `--attach` | 不启动新任务，只接着看上次的部署进度 |

## 仓库指向（两端都跟 fork，不跟上游）

| 位置 | remote | 指向 |
|---|---|---|
| 本机 | `fork`（可用 `GIT_REMOTE` 改名） | `XHF-M/qq-farm-bot` |
| 服务器 `APP_DIR` | `origin` | `XHF-M/qq-farm-bot` |

上游 `liyangpengs/qq-farm-bot` 已于 2026-11-25 停更，但本机 `origin` 仍指向它。
所以本机同步**必须**走 `GIT_REMOTE`（默认 `fork`），否则会把上游提交顺手合并进来。

```bash
git push fork master   # 本机只推 fork
redeploy.bat           # 本机合并 fork/master -> 服务器 reset 到同一提交
```

## 它做了什么

服务器端 `redeploy.sh` 七步：

1. 环境检查（swap 不足自动补 2G，1.6G 内存机型构建必需）
2. 备份 `.env` 与 `docker-compose.override.yml` 到 `$BACKUP_DIR`（默认 `/root/backups`）
3. `git fetch --depth 1` + `reset --hard origin/<branch>`
4. 幂等补回被 `reset` 冲掉的 `.env` 构建参数（`NPM_REGISTRY` / `NODE_IMAGE` / `PNPM_VERSION`）
5. `docker compose build`（边跑边汇报 layer 进度，不再"看起来卡死"）
6. `docker compose up -d --force-recreate`（限时 600 秒 + 3 次重试 + `docker start` 兜底）
7. `nginx -s reload`（清旧容器 IP 缓存）+ 4 项校验：首页 / `api/game-version` / socket.io 握手 / WebSocket 101

## 为什么断线也能跑完

服务器端用 `setsid` 后台执行，**SSH 掉线、关窗口、关电脑都不影响**部署。
本机 `redeploy.py` 只做日志增量轮询（SFTP 按 offset 续读 `/tmp/redeploy-current.log`），
脚本结尾写 `__REDEPLOY_DONE__ rc=<0|1>` 作为结束标记。
重跑 `--attach` 接着看进度即可。

服务器脚本会把自身 pid 写进 `/tmp/redeploy.pid`。本机启动前先查这个 pid：
**已有任务在跑就不再起第二个**（1.6G 机器上并行构建会互相拖死），直接接管进度。

## 已知坑（都已在内置兜底）

| 现象 | 原因 | 处理 |
|---|---|---|
| 本机卡在「启动服务器部署任务」60 秒后超时 | `out.read()` 等 channel EOF，而后台守护进程继承了通道 fd，EOF 永远不来 | 改为非阻塞 `recv` + 双重 fork，孙进程输出直连日志，不占通道 |
| 长时间无输出像是卡死 | 构建阶段一层 layer 要跑十几分钟 | 本机每 30 秒打一次心跳（静默秒数 + 日志字节数），服务器每 15 秒报当前 layer |
| 连点两次 / 重跑脚本发起两个构建 | 没有互斥 | `/tmp/redeploy.pid` + `kill -0` 判断，自动接管而非重复启动 |
| `docker compose up -d` 卡几分钟，容器停在 `Created` | 1.6G 内存机型上 compose 偶发无响应 | `timeout 600` + 3 次重试 + `docker start` 兜底 |
| 构建后仍跑旧镜像 | compose 认为 tag 未变 | 构建后强制 `--force-recreate`（数据卷保留） |
| `NPM_REGISTRY` 每次部署后丢失 | `.env` 被 git 跟踪，`reset --hard` 会覆盖 | 第 4 步幂等补回 |
| 公网 502 但容器 healthy | nginx 缓存了旧容器 IP | 第 7 步自动 `nginx -s reload` |
| 构建卡在 pnpm / vite 不推进 | swap 没开，纯换页抖动 | 第 1 步自动补 2G swap |
| cmd 窗口里日志是 `←[36m` 乱码 | cmd 默认不开 VT 处理 | 启动时用 `SetConsoleMode` 开 VT，失败则自动关闭颜色并剥掉远端转义码 |

## 部署后

容器重启后**账号不会自动启动**，需到面板手动点「启动」。
