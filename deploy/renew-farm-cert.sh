#!/usr/bin/env bash
# farm 子域证书自动续期
# 该域名走 TLS-ALPN-01（80 被云厂商拦截），续期需独占 443，故必须短暂停 nginx。
# 关键：恢复动作无条件执行 —— acme.sh 的 --post-hook 在失败时不跑，会导致官网长时间中断。
set -uo pipefail

DOMAIN="${DOMAIN:-farm.example.com}"
NGINX_DIR="${NGINX_DIR:-/root/docker/nginx-gateway}"
NGINX_CONTAINER="${NGINX_CONTAINER:-nginx-gateway}"
ACME_HOME="${ACME_HOME:-/root/.acme.sh}"
CERT_DIR="$NGINX_DIR/ssl/$DOMAIN"
LOG="${LOG:-/var/log/qq-farm-cert.log}"
THRESHOLD_DAYS="${THRESHOLD_DAYS:-30}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "$SCRIPT_DIR/.deploy.env" ] && . "$SCRIPT_DIR/.deploy.env"

log() { echo "[$(date '+%F %T')] $*" >> "$LOG"; }

if [ ! -f "$CERT_DIR/farm.pem" ]; then
  log "证书不存在，交给 deploy.sh cert 处理"
  exit 1
fi

END_TS=$(date -d "$(openssl x509 -in "$CERT_DIR/farm.pem" -noout -enddate | cut -d= -f2)" +%s)
DAYS=$(( (END_TS - $(date +%s)) / 86400 ))
log "--- $DOMAIN 剩余 $DAYS 天 ---"

if [ "$DAYS" -gt "$THRESHOLD_DAYS" ]; then
  exit 0
fi

log "停 nginx 释放 443"
( cd "$NGINX_DIR" && docker compose stop nginx >/dev/null 2>&1 ) || true
sleep 2

"$ACME_HOME/acme.sh" --renew -d "$DOMAIN" --ecc --force >> "$LOG" 2>&1
RC=$?

log "恢复 nginx（无条件）"
( cd "$NGINX_DIR" && docker compose start nginx >/dev/null 2>&1 ) || true
sleep 3
if ! docker ps --format '{{.Names}}' | grep -qx "$NGINX_CONTAINER"; then
  log "网关未起，up -d 兜底"
  ( cd "$NGINX_DIR" && docker compose up -d nginx >/dev/null 2>&1 ) || true
  sleep 3
fi

if [ "$RC" -ne 0 ]; then
  log "续期失败 rc=$RC（nginx 已恢复，旧证书仍有效）"
  exit "$RC"
fi

openssl x509 -in "$CERT_DIR/farm.pem" -noout -dates >> "$LOG" 2>&1
docker exec "$NGINX_CONTAINER" nginx -s reload >> "$LOG" 2>&1
log "--- 续期完成 ---"
