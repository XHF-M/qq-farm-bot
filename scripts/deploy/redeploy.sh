#!/usr/bin/env bash
# qq-farm-bot 服务器一键重部署
#
# 用法:
#   bash redeploy.sh               # 拉上游最新 + 构建 + 重启 + 验证
#   bash redeploy.sh --skip-build  # 不构建镜像，只重启容器 + 验证
#   bash redeploy.sh --verify-only # 只做健康验证
#
# 可选环境变量: APP_DIR / BRANCH / BACKUP_DIR / LOG
# 结束时会写一行 `__REDEPLOY_DONE__ rc=<0|1>`，供调用方轮询判断。
set -uo pipefail

APP_DIR="${APP_DIR:-/root/docker/qq-farm-bot}"
BACKUP_DIR="${BACKUP_DIR:-/root/backups}"
BRANCH="${BRANCH:-master}"
LOG="${LOG:-/tmp/redeploy-current.log}"
SKIP_BUILD=0
VERIFY_ONLY=0
TS="$(date +%Y%m%d-%H%M%S)"

for arg in "$@"; do
  case "$arg" in
    --skip-build) SKIP_BUILD=1 ;;
    --verify-only) VERIFY_ONLY=1 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "未知参数: $arg"; exit 2 ;;
  esac
done

RED=$'\033[31m'; GRN=$'\033[32m'; CYN=$'\033[36m'; BLD=$'\033[1m'; RST=$'\033[0m'
step() { printf '\n%s==> %s%s\n' "$BLD$CYN" "$*" "$RST"; }
ok()   { printf '%s  OK  %s%s\n' "$GRN" "$*" "$RST"; }
err()  { printf '%s FAIL %s%s\n' "$RED" "$*" "$RST"; }
die()  { err "$*"; echo "日志: $LOG"; echo "__REDEPLOY_DONE__ rc=1"; exit 1; }

START_TS=$(date +%s)

step "0/7 环境检查"
[ -d "$APP_DIR/.git" ] || die "$APP_DIR 不是 git 仓库"
cd "$APP_DIR" || die "无法进入 $APP_DIR"
echo "应用目录: $APP_DIR"
echo "分支     : $BRANCH"
echo "当前提交 : $(git log --oneline -1)"

# --- swap 兜底（1.6G 内存机型构建必用，重装/重启后会自动补回） ---
SWAP_MB=$(awk '/SwapTotal/{print int($2/1024)}' /proc/meminfo)
if [ "$SWAP_MB" -lt 2000 ]; then
  step "swap 只有 ${SWAP_MB}MB，补 2G"
  if [ ! -f /swapfile2 ]; then
    fallocate -l 2G /swapfile2 && chmod 600 /swapfile2 && mkswap /swapfile2 >/dev/null
  fi
  swapon /swapfile2 2>/dev/null || true
fi
echo "内存: $(free -m | awk '/^Mem:/{print $2"MB total / "$7"MB avail"}')  swap: $(free -m | awk '/^Swap:/{print $2"MB"}')"
echo "磁盘: $(df -h / | awk 'NR==2{print $4" 可用 ("$5" 已用)"}')"

if [ "$VERIFY_ONLY" -eq 0 ]; then
  step "1/7 备份 .env 与 compose override"
  mkdir -p "$BACKUP_DIR"
  cp -f .env "$BACKUP_DIR/env.${TS}" 2>/dev/null && ok ".env -> $BACKUP_DIR/env.${TS}"
  [ -f docker-compose.override.yml ] && cp -f docker-compose.override.yml "$BACKUP_DIR/override.${TS}" && ok "override -> $BACKUP_DIR/override.${TS}"

  step "2/7 拉取上游最新代码"
  git fetch --depth 1 origin "$BRANCH" || die "git fetch 失败（网络或 GitHub 凭据问题）"
  BEFORE=$(git rev-parse --short HEAD)
  git reset --hard "origin/${BRANCH}" || die "git reset 失败"
  AFTER=$(git rev-parse --short HEAD)
  ok "代码更新 $BEFORE -> $AFTER"
  echo "最新提交: $(git log --oneline -1)"

  step "3/7 恢复 .env 构建参数"
  # .env 被 git 跟踪，reset 会把手改的镜像源参数冲掉，这里幂等补回
  if ! grep -q '^NPM_REGISTRY=' .env 2>/dev/null; then
    printf '\n# --- 服务器部署追加（redeploy.sh 自动补齐） ---\nNPM_REGISTRY=https://registry.npmmirror.com/\nNODE_IMAGE=node:20-alpine\nPNPM_VERSION=10.30.2\n' >> .env
    ok "已补回 NPM_REGISTRY / NODE_IMAGE / PNPM_VERSION"
  else
    ok ".env 构建参数正常"
  fi
  grep -E '^(NPM_REGISTRY|NODE_IMAGE|PNPM_VERSION|PORT|TZ)=' .env | sed 's/^/    /'

  if [ "$SKIP_BUILD" -eq 0 ]; then
    step "4/7 构建镜像（1.6G 机型首次约 20 分钟，有缓存约 5-8 分钟）"
    BUILD_LOG="/tmp/build-${TS}.log"
    docker compose build >"$BUILD_LOG" 2>&1 &
    BUILD_PID=$!
    # 边跑边汇报关键节点，避免长时间无输出让人以为卡死
    while kill -0 "$BUILD_PID" 2>/dev/null; do
      sleep 20
      LAST=$(grep -E '^#[0-9]+ \[' "$BUILD_LOG" | tail -1)
      [ -n "$LAST" ] && echo "  ... $LAST"
    done
    wait "$BUILD_PID"
    BUILD_RC=$?
    if [ "$BUILD_RC" -ne 0 ]; then
      tail -40 "$BUILD_LOG"
      die "镜像构建失败，完整日志 $BUILD_LOG"
    fi
    ok "镜像构建完成（日志 $BUILD_LOG）"
  else
    step "4/7 跳过构建（--skip-build）"
  fi

  step "5/7 重启容器"
  # compose up 在内存紧张的机器上偶发长时间无响应甚至被信号打断，
  # 这里限时+重试，最后兜底 docker start，保证容器一定起来。
  # 本次构建过镜像就强制重建容器，避免 compose 认为 tag 未变而继续跑旧镜像。
  UP_ARGS="-d"
  [ "$SKIP_BUILD" -eq 0 ] && UP_ARGS="-d --force-recreate"
  UP_OK=0
  for attempt in 1 2 3; do
    if timeout 600 docker compose up $UP_ARGS 2>&1 | tail -5; then
      UP_OK=1
      break
    fi
    echo "  第 ${attempt} 次 compose up 未成功，10 秒后重试"
    sleep 10
  done
  if [ "$UP_OK" -eq 0 ]; then
    echo "  compose up 三次失败，兜底 docker start qq-farm-bot"
    docker start qq-farm-bot || die "容器无法启动"
  fi
  ok "容器已启动"
else
  step "跳过 1-5（--verify-only）"
fi

step "6/7 等待健康检查"
HEALTH=unknown
for i in $(seq 1 60); do
  HEALTH=$(docker inspect -f '{{.State.Health.Status}}' qq-farm-bot 2>/dev/null || echo missing)
  [ "$HEALTH" = "healthy" ] && break
  [ "$HEALTH" = "missing" ] && die "容器不存在"
  sleep 3
done
if [ "$HEALTH" = "healthy" ]; then ok "容器 healthy"; else err "容器状态 $HEALTH（继续验证）"; fi
docker stats --no-stream --format '    资源: {{.CPUPerc}} CPU / {{.MemUsage}}' qq-farm-bot 2>/dev/null

step "7/7 nginx reload + 端到端验证"
docker exec nginx-gateway nginx -t >/dev/null 2>&1 && docker exec nginx-gateway nginx -s reload >/dev/null 2>&1 && ok "nginx reloaded（清掉旧容器 IP 缓存）"
sleep 2

D="farm.yisuu.com.cn"
FAIL=0
chk() { # name expected_code [curl args...]
  local name="$1" want="$2"; shift 2
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' --resolve "$D:443:127.0.0.1" --max-time 15 "$@")
  if [ "$code" = "$want" ]; then ok "$name HTTP $code"; else err "$name HTTP $code（期望 $want）"; FAIL=1; fi
}
chk "首页"           200 "https://$D/"
chk "game-version"   200 "https://$D/api/game-version"
chk "socket.io 握手" 200 "https://$D/socket.io/?EIO=4&transport=polling"
chk "WebSocket 升级" 101 -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
    -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
    "https://$D/socket.io/?EIO=4&transport=websocket"

echo "    版本接口: $(curl -s --resolve "$D:443:127.0.0.1" --max-time 10 "https://$D/api/game-version")"

if docker exec qq-farm-bot sh -c 'test -f dist/services/ranch/index.js' >/dev/null 2>&1; then
  ok "牧场模块已在镜像内（dist/services/ranch）"
else
  echo "    提示: 镜像内没有 dist/services/ranch（旧版本可能本来就没有牧场）"
fi

if [ "$FAIL" -ne 0 ]; then
  err "验证有失败项，容器日志尾部："
  docker logs --tail 30 qq-farm-bot 2>&1 | sed 's/^/    /'
fi

COST=$(( $(date +%s) - START_TS ))
printf '\n%s完成，耗时 %d 分 %d 秒%s\n' "$BLD" $((COST/60)) $((COST%60)) "$RST"
echo "日志: $LOG"
echo "提示: 容器重启后账号不会自动启动，需到面板手动点「启动」。"
echo "__REDEPLOY_DONE__ rc=$FAIL"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
