#!/usr/bin/env bash
# =============================================================================
# qq-farm-bot 一键部署脚本（Docker + nginx 反代 + Let's Encrypt 证书）
#
# 适用：一台已有 nginx 网关（Docker Compose 管理）的 Linux 服务器，
#       本项目作为新容器接入，不占用宿主机端口，公网只经网关进入。
#
# 用法：
#   bash deploy.sh all          # 全流程（幂等，可重复执行）
#   bash deploy.sh app          # 只构建并启动容器
#   bash deploy.sh cert         # 只签发/检查证书（会短暂停 nginx）
#   bash deploy.sh nginx        # 只写网关配置并 reload
#   bash deploy.sh auth         # 只生成/重置 Basic Auth 密码
#   bash deploy.sh cron         # 只配自动续期
#   bash deploy.sh verify       # 只做端到端验证
#   bash deploy.sh status       # 看容器/证书/配置现状
#
# 覆盖默认值：在脚本同目录建 .deploy.env（KEY=VALUE），或直接环境变量传入。
# =============================================================================
set -euo pipefail

# ----------------------------- 可配置项 --------------------------------------
DOMAIN="${DOMAIN:-farm.example.com}"
APP_DIR="${APP_DIR:-/root/docker/qq-farm-bot}"
NGINX_DIR="${NGINX_DIR:-/root/docker/nginx-gateway}"
NGINX_CONTAINER="${NGINX_CONTAINER:-nginx-gateway}"
APP_CONTAINER="${APP_CONTAINER:-qq-farm-bot}"
APP_PORT="${APP_PORT:-3007}"
NETWORK="${NETWORK:-web-net}"
MEM_LIMIT="${MEM_LIMIT:-700m}"
GIT_REPO="${GIT_REPO:-https://github.com/liyangpengs/qq-farm-bot.git}"
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmmirror.com/}"
NODE_IMAGE="${NODE_IMAGE:-node:20-alpine}"
ACME_EMAIL="${ACME_EMAIL:-admin@${DOMAIN#*.}}"
ACME_HOME="${ACME_HOME:-/root/.acme.sh}"
CERT_DIR=""   # 在配置加载后计算
# Basic Auth 默认关闭（面板本身有登录密码）；需要时置为 true 并重跑 nginx 阶段
BASIC_AUTH_ENABLED="${BASIC_AUTH_ENABLED:-false}"
BASIC_AUTH_USER="${BASIC_AUTH_USER:-farm}"
LOG_DIR="${LOG_DIR:-/var/log}"
# 80 端口是否被云厂商 ICP 拦截；true 时只能用 TLS-ALPN-01
PORT80_BLOCKED="${PORT80_BLOCKED:-auto}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "$SCRIPT_DIR/.deploy.env" ] && . "$SCRIPT_DIR/.deploy.env"

CERT_DIR="$NGINX_DIR/ssl/$DOMAIN"
HTPASSWD="$NGINX_DIR/conf.d/farm.htpasswd"
LOG="$LOG_DIR/qq-farm-deploy.log"

# ----------------------------- 工具函数 --------------------------------------
C_OK='\033[0;32m'; C_WARN='\033[1;33m'; C_ERR='\033[0;31m'; C_DIM='\033[0;90m'; C_NC='\033[0m'
log()  { echo -e "[$(date '+%F %T')] $*" | tee -a "$LOG"; }
ok()   { log "${C_OK}OK${C_NC}   $*"; }
warn() { log "${C_WARN}WARN${C_NC} $*"; }
die()  { log "${C_ERR}FAIL${C_NC} $*"; exit 1; }
step() { log ""; log "${C_DIM}──────── $* ────────${C_NC}"; }

need_root() { [ "$(id -u)" -eq 0 ] || die "请用 root 运行"; }

# ----------------------------- 0. 环境检查 -----------------------------------
stage_check() {
  step "0. 环境检查"
  need_root
  command -v docker >/dev/null || die "未安装 docker"
  docker compose version >/dev/null 2>&1 || die "未安装 docker compose v2"
  docker network inspect "$NETWORK" >/dev/null 2>&1 \
    || die "网络 $NETWORK 不存在，请先建：docker network create $NETWORK"
  docker ps --format '{{.Names}}' | grep -qx "$NGINX_CONTAINER" \
    || die "网关容器 $NGINX_CONTAINER 未运行"
  command -v openssl >/dev/null || die "未安装 openssl"

  local av mem_kb
  av=$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo)
  mem_kb=$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo)
  log "内存 总 ${mem_kb}MB / 可用 ${av}MB，CPU $(nproc) 核"
  [ "$av" -lt 400 ] && warn "可用内存低于 400MB，构建可能 OOM，建议加 swap"
  ok "环境就绪"
}

# ----------------------------- 1. 拉取与配置 ---------------------------------
stage_app() {
  step "1. 部署应用容器"
  need_root

  if [ -d "$APP_DIR/.git" ]; then
    log "目录已存在，尝试更新"
    git -C "$APP_DIR" fetch --depth 1 origin >/dev/null 2>&1 \
      && git -C "$APP_DIR" reset --hard origin/HEAD >/dev/null 2>&1 \
      && ok "已更新到最新" || warn "更新失败，继续用当前代码"
  else
    log "克隆 $GIT_REPO"
    mkdir -p "$(dirname "$APP_DIR")"
    git clone --depth 1 "$GIT_REPO" "$APP_DIR" || die "克隆失败"
    ok "克隆完成"
  fi

  # .env：追加而非覆盖（仓库自带 .env 有 PORT/TZ/NODE_ENV）
  log "写入 .env"
  grep -q '^NPM_REGISTRY=' "$APP_DIR/.env" 2>/dev/null \
    || printf '\n# 部署追加\nNPM_REGISTRY=%s\nNODE_IMAGE=%s\n' "$NPM_REGISTRY" "$NODE_IMAGE" >> "$APP_DIR/.env"

  # override：清空宿主机端口映射 + 内存上限 + 接入网关网络
  log "写入 docker-compose.override.yml"
  cat > "$APP_DIR/docker-compose.override.yml" <<YAML
services:
  ${APP_CONTAINER}:
    # 清空主 compose 的宿主机端口映射：唯一入口是 nginx 网关
    ports: !reset []
    expose:
      - "${APP_PORT}"
    mem_limit: ${MEM_LIMIT}
    healthcheck:
      # 必须用 127.0.0.1：容器内 localhost 会解析到 ::1，而服务只监听 IPv4
      test: ["CMD", "wget", "-q", "--spider", "http://127.0.0.1:${APP_PORT}/api/game-version"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 30s
    networks:
      - default
      - ${NETWORK}

networks:
  ${NETWORK}:
    external: true
YAML

  log "构建镜像（首次约 3-5 分钟）"
  ( cd "$APP_DIR" && docker compose build 2>&1 | tail -5 )

  log "启动容器"
  ( cd "$APP_DIR" && docker compose up -d 2>&1 | tail -3 )

  log "等待健康检查"
  local i
  for i in $(seq 1 30); do
    docker ps --format '{{.Names}}\t{{.Status}}' | grep -q "^${APP_CONTAINER}.*healthy" && break
    sleep 3
  done
  docker ps --filter "name=^${APP_CONTAINER}$" --format '   {{.Names}} | {{.Status}}'
  docker exec "$APP_CONTAINER" wget -q -O - "http://127.0.0.1:${APP_PORT}/api/game-version" >/dev/null \
    && ok "应用就绪" || die "应用未响应，看日志：docker logs $APP_CONTAINER"
}

# ----------------------------- 2. 证书 ---------------------------------------
detect_port80() {
  if [ "$PORT80_BLOCKED" = "auto" ]; then
    # 从公网取本机 80 端口，看是否被云厂商拦截（Server: Beaver / ICP 页面）
    local out
    out=$(curl -sS -m 8 -o /dev/null -w '%{http_code} %{header_json}' "http://$DOMAIN/.well-known/acme-challenge/probe" 2>/dev/null || echo "")
    if echo "$out" | grep -qi 'beaver'; then
      PORT80_BLOCKED=true
    else
      PORT80_BLOCKED=false
    fi
    log "80 端口探测结果：PORT80_BLOCKED=$PORT80_BLOCKED"
  fi
}

install_acme() {
  [ -x "$ACME_HOME/acme.sh" ] && return 0
  log "安装 acme.sh（raw.githubusercontent 常被 reset，走 gitee 镜像）"
  mkdir -p "$ACME_HOME"
  local url
  for url in \
    "https://gitee.com/neilpang/acme.sh/raw/master/acme.sh" \
    "https://cdn.jsdelivr.net/gh/acmesh-official/acme.sh@master/acme.sh" \
    "https://raw.githubusercontent.com/acmesh-official/acme.sh/master/acme.sh"; do
    if curl -fsSL -m 30 "$url" -o "$ACME_HOME/acme.sh"; then
      chmod +x "$ACME_HOME/acme.sh" && ok "acme.sh 就绪 ($url)" && break
    fi
  done
  [ -x "$ACME_HOME/acme.sh" ] || die "acme.sh 下载失败，请手动上传到 $ACME_HOME/acme.sh"
  "$ACME_HOME/acme.sh" --set-default-ca --server letsencrypt >/dev/null 2>&1 || true
}

cert_days_left() {
  [ -f "$CERT_DIR/farm.pem" ] || { echo 0; return; }
  local end
  end=$(date -d "$(openssl x509 -in "$CERT_DIR/farm.pem" -noout -enddate | cut -d= -f2)" +%s)
  echo $(( (end - $(date +%s)) / 86400 ))
}

stage_cert() {
  step "2. 证书"
  need_root
  install_acme

  local days
  days=$(cert_days_left)
  if [ "$days" -gt 30 ]; then
    ok "证书剩余 ${days} 天，跳过签发"
    return 0
  fi

  detect_port80
  local method
  if [ "$PORT80_BLOCKED" = "true" ]; then
    method="--alpn"
    warn "80 端口被云厂商拦截，改用 TLS-ALPN-01（nginx 需停约 25 秒）"
  else
    method="--webroot -w /var/www/acme"
    log "80 端口可用，使用 HTTP-01"
  fi

  # 无论成败都要恢复 nginx —— acme.sh 的 --post-hook 失败时不执行，不能依赖
  log "停止网关容器"
  ( cd "$NGINX_DIR" && docker compose stop nginx >/dev/null 2>&1 ) || true
  sleep 2

  local rc=0
  # shellcheck disable=SC2086
  "$ACME_HOME/acme.sh" --issue $method -d "$DOMAIN" --server letsencrypt 2>&1 | tail -20 || rc=$?

  log "恢复网关容器"
  ( cd "$NGINX_DIR" && docker compose start nginx >/dev/null 2>&1 ) || true
  sleep 3
  docker ps --filter "name=^${NGINX_CONTAINER}$" --format '   {{.Names}} | {{.Status}}'
  if ! docker ps --format '{{.Names}}' | grep -qx "$NGINX_CONTAINER"; then
    warn "网关未启动，执行 up -d 兜底"
    ( cd "$NGINX_DIR" && docker compose up -d nginx >/dev/null 2>&1 ) || true
  fi

  if [ "$rc" -ne 0 ]; then
    die "证书签发失败（rc=$rc），nginx 已恢复。日志：$LOG"
  fi

  mkdir -p "$CERT_DIR"
  "$ACME_HOME/acme.sh" --install-cert -d "$DOMAIN" \
    --key-file       "$CERT_DIR/farm.key" \
    --fullchain-file "$CERT_DIR/farm.pem" \
    --reloadcmd      "docker exec $NGINX_CONTAINER nginx -s reload" 2>&1 | tail -4
  openssl x509 -in "$CERT_DIR/farm.pem" -noout -subject -dates
  ok "证书已安装"
}

# ----------------------------- 3. 网关配置 -----------------------------------
stage_nginx() {
  step "3. 网关反代配置"
  need_root
  [ -f "$CERT_DIR/farm.pem" ] || die "证书不存在，先执行：bash $0 cert"

  mkdir -p "$NGINX_DIR/acme/.well-known/acme-challenge"

  # 挂载 acme 目录（用 override，不改人家主 compose）
  if [ ! -f "$NGINX_DIR/docker-compose.override.yml" ] \
     || ! grep -q "$NGINX_DIR/acme" "$NGINX_DIR/docker-compose.override.yml"; then
    log "为网关追加 acme 目录挂载"
    cat > "$NGINX_DIR/docker-compose.override.yml" <<YAML
services:
  nginx:
    volumes:
      - ${NGINX_DIR}/acme:/var/www/acme
YAML
    ( cd "$NGINX_DIR" && docker compose up -d 2>&1 | tail -3 )
    sleep 5
  fi

  # 站点配置
  local auth_block=""
  if [ "$BASIC_AUTH_ENABLED" = "true" ]; then
    auth_block='    # 访问认证（密码：bash '"$0"' auth 查看/重置）
    auth_basic "Farm Panel";
    auth_basic_user_file /etc/nginx/conf.d/farm.htpasswd;
'
  fi
  log "写入 conf.d/farm.conf（Basic Auth: $BASIC_AUTH_ENABLED）"
  cat > "$NGINX_DIR/conf.d/farm.conf" <<NGINX
# $DOMAIN —— qq-farm-bot 挂机面板
# 证书：Let's Encrypt（TLS-ALPN-01，80 端口被云厂商拦截故不能用 HTTP-01）
# 续期：crontab -> $SCRIPT_DIR/renew-farm-cert.sh

map \$http_upgrade \$farm_conn_upgrade {
    default upgrade;
    ''      close;
}

# 80：ACME 兜底 + 跳转
server {
    listen 80;
    server_name $DOMAIN;

    location /.well-known/acme-challenge/ {
        root /var/www/acme;
        default_type "text/plain";
        try_files \$uri =404;
    }

    location / { return 301 https://\$host\$request_uri; }
}

# 443：面板入口
server {
    listen 443 ssl;
    server_name $DOMAIN;

    ssl_certificate     /etc/nginx/ssl/$DOMAIN/farm.pem;
    ssl_certificate_key /etc/nginx/ssl/$DOMAIN/farm.key;

    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_session_cache shared:farm_ssl:10m;
    ssl_session_timeout 1h;

    client_max_body_size 50m;

$auth_block
    location / {
        proxy_pass http://$APP_CONTAINER:$APP_PORT;
        proxy_http_version 1.1;

        # Socket.IO / WebSocket 必须
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$farm_conn_upgrade;

        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;

        # 长连接：实时日志/状态推送
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_buffering off;
    }
}
NGINX

  if [ "$BASIC_AUTH_ENABLED" = "true" ] && [ ! -f "$HTPASSWD" ]; then
    log "生成 Basic Auth 密码"
    stage_auth
  fi

  log "语法检查"
  docker exec "$NGINX_CONTAINER" nginx -t 2>&1 | tail -2 || die "nginx 配置语法错误，已中止（未 reload）"
  docker exec "$NGINX_CONTAINER" nginx -s reload
  ok "网关配置生效"
}

# ----------------------------- 4. 访问认证 -----------------------------------
stage_auth() {
  step "4. 访问认证"
  need_root
  if [ "$BASIC_AUTH_ENABLED" != "true" ]; then
    warn "BASIC_AUTH_ENABLED=false，网关当前未启用 Basic Auth"
    warn "要启用：BASIC_AUTH_ENABLED=true bash $0 nginx"
  fi
  local pass="${1:-}"
  if [ -z "$pass" ]; then
    pass=$(openssl rand -base64 12 | tr -dc 'A-Za-z0-9' | cut -c1-14)
  fi
  local hash
  hash=$(openssl passwd -apr1 "$pass")

  mkdir -p "$(dirname "$HTPASSWD")"
  echo "$BASIC_AUTH_USER:$hash" > "$HTPASSWD"
  chmod 644 "$HTPASSWD"

  # 网关需挂载 conf.d 才能读到；本脚本假定 conf.d 已挂载（标准做法）
  if docker exec "$NGINX_CONTAINER" test -f /etc/nginx/conf.d/farm.htpasswd; then
    docker exec "$NGINX_CONTAINER" nginx -s reload 2>/dev/null || true
  else
    warn "网关容器看不到 $HTPASSWD，请确认 $NGINX_DIR/conf.d 已挂载到 /etc/nginx/conf.d"
  fi

  log ""
  log "  ${C_WARN}请立即保存以下凭据${C_NC}"
  log "  地址：https://$DOMAIN"
  log "  用户名：$BASIC_AUTH_USER"
  log "  密码：  ${C_OK}$pass${C_NC}"
  log ""
}

# ----------------------------- 5. 自动续期 -----------------------------------
stage_cron() {
  step "5. 自动续期"
  need_root
  local s="$SCRIPT_DIR/renew-farm-cert.sh"
  chmod +x "$s" 2>/dev/null || true
  if crontab -l 2>/dev/null | grep -q "renew-farm-cert"; then
    ok "crontab 已存在，跳过"
  else
    ( crontab -l 2>/dev/null; echo "17 4 * * * $s >> $LOG 2>&1" ) | crontab -
    ok "已添加：每天 04:17 检查续期"
  fi
  crontab -l | grep renew-farm-cert || true
}

# ----------------------------- 6. 验证 ---------------------------------------
stage_verify() {
  step "6. 端到端验证"
  local code
  code=$(curl -sS -m 15 -o /dev/null -w '%{http_code}' "https://$DOMAIN/" || echo 000)
  if [ "$code" = "200" ]; then
    ok "HTTPS 可达（200）"
  elif [ "$code" = "401" ]; then
    ok "HTTPS 可达（401 = Basic Auth 生效，需带凭据）"
  else
    die "HTTPS 访问异常：$code"
  fi

  local auth=()
  if [ -n "${BASIC_AUTH_PASS:-}" ]; then
    auth=(-u "$BASIC_AUTH_USER:$BASIC_AUTH_PASS")
  fi
  log "应用接口：$(curl -sS -m 15 "${auth[@]}" -o /dev/null -w '%{http_code}' "https://$DOMAIN/api/game-version" || echo 000)"
  log "Socket.IO：$(curl -sS -m 15 "${auth[@]}" -o /dev/null -w '%{http_code}' "https://$DOMAIN/socket.io/?EIO=4&transport=polling" || echo 000)"
  log "证书：$(echo | openssl s_client -connect "$DOMAIN:443" -servername "$DOMAIN" 2>/dev/null | openssl x509 -noout -subject -dates 2>/dev/null | tr '\n' ' ')"
  ok "验证完成（浏览器打开 https://$DOMAIN）"
}

stage_status() {
  step "现状"
  docker ps --filter "name=^${APP_CONTAINER}$" --format '   {{.Names}} | {{.Status}}' || true
  docker ps --filter "name=^${NGINX_CONTAINER}$" --format '   {{.Names}} | {{.Status}}' || true
  log "   证书剩余 $(cert_days_left) 天"
  log "   配置：$NGINX_DIR/conf.d/farm.conf"
  log "   日志：$APP_DIR -> docker logs $APP_CONTAINER"
}

# ----------------------------- 入口 ------------------------------------------
main() {
  mkdir -p "$LOG_DIR"
  touch "$LOG"
  case "${1:-all}" in
    all)    stage_check; stage_app; stage_cert; stage_nginx; stage_cron; stage_verify ;;
    check)  stage_check ;;
    app)    stage_check; stage_app ;;
    cert)   stage_cert ;;
    nginx)  stage_nginx ;;
    auth)   stage_auth "${2:-}" ;;
    cron)   stage_cron ;;
    verify) stage_verify ;;
    status) stage_status ;;
    *)      echo "用法：bash $0 {all|check|app|cert|nginx|auth [密码]|cron|verify|status}"; exit 1 ;;
  esac
}

main "$@"
