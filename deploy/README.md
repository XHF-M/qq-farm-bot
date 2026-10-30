# 部署脚本

把 qq-farm-bot 部署到一台**已有 nginx 网关的 Linux 服务器**上，并配好 HTTPS。

## 文件

| 文件 | 用途 |
|---|---|
| `deploy.sh` | 一键部署（幂等，可分阶段执行） |
| `renew-farm-cert.sh` | 证书自动续期，由 crontab 调用 |
| `.deploy.env.example` | 配置模板，复制成 `.deploy.env` 后按需修改 |

## 前置条件

1. Linux + Docker 20+ / Compose v2
2. 已有一个 nginx 网关容器，挂载了 `<网关目录>/conf.d` → `/etc/nginx/conf.d`
3. 已有 Docker 网络 `web-net`（或自定义，用 `NETWORK` 覆盖）
4. 域名 A 记录已指向本机，且 **443 端口对公网可达**

## 用法

```bash
# 1) 把 deploy/ 目录传到服务器
scp -r deploy root@<IP>:/root/servers/

# 2) 复制配置并改
cd /root/servers/deploy
cp .deploy.env.example .deploy.env
vi .deploy.env

# 3) 全流程（幂等，可重复跑）
bash deploy.sh all
```

分阶段：

```bash
bash deploy.sh check     # 只做环境检查
bash deploy.sh app       # 只构建+启动容器
bash deploy.sh cert      # 只处理证书（会停 nginx 约 25 秒）
bash deploy.sh nginx     # 只写网关配置并 reload
bash deploy.sh auth      # 生成/重置 Basic Auth 密码（默认关闭，见下）
bash deploy.sh cron      # 只配自动续期
bash deploy.sh verify    # 只做端到端验证
bash deploy.sh status    # 看现状
```

## 设计要点

**不占宿主机端口。** 用 `docker-compose.override.yml` 的 `ports: !reset []` 清空端口映射，
只 `expose 3007`，接入 `web-net`。公网唯一入口是 nginx 网关，外部无法直连 3007。

**不改项目主 compose。** 所有改动都在 override 文件里，`git status` 保持干净。

**证书自动选验证方式。** `PORT80_BLOCKED=auto` 会自动探测 80 端口是否被云厂商 ICP 拦截
（响应头带 `Server: Beaver`）：
- 未拦截 → HTTP-01（webroot，零中断）
- 被拦截 → **TLS-ALPN-01**（停 nginx 约 25 秒，因为要独占 443）

**续期失败不会把官网弄挂。** `renew-farm-cert.sh` 的「恢复 nginx」是无条件执行的。
不能用 acme.sh 的 `--post-hook`——它只在成功后跑，签失败时 nginx 会一直停着。

**Basic Auth 默认关闭。** 面板本身有登录密码，再加一层 nginx 认证会让手机每次打开都弹框。
需要时置 `BASIC_AUTH_ENABLED=true` 后重跑 `nginx` 阶段（会自动生成密码并打印）。

## 配置项（`.deploy.env`）

```bash
DOMAIN=farm.example.com          # 访问域名
APP_DIR=/root/docker/qq-farm-bot # 项目落地目录
NGINX_DIR=/root/docker/nginx-gateway
NGINX_CONTAINER=nginx-gateway
NETWORK=web-net
APP_PORT=3007
MEM_LIMIT=700m                   # 每账号约 +150MB 内存
BASIC_AUTH_ENABLED=false         # true 则启用 nginx Basic Auth
BASIC_AUTH_USER=farm
PORT80_BLOCKED=auto              # auto | true | false
NPM_REGISTRY=https://registry.npmmirror.com/
```

## 部署后

1. 浏览器打开 `https://<DOMAIN>`，用面板账号登录（未开 Basic Auth，不会弹框）
2. **立刻改掉默认 `admin` / `admin`**（首次登录返回 `mustChangePassword: true`）
3. 账号不会随容器重启自动启动（项目刻意设计），需在面板手动点启动

## 排错

```bash
docker logs -f qq-farm-bot          # 应用日志
tail -f /var/log/qq-farm-deploy.log # 部署日志
tail -f /var/log/qq-farm-cert.log   # 证书续期日志

# 容器不健康
docker inspect -f '{{json .State.Health}}' qq-farm-bot | head -c 500

# 网关配置错了，回滚
rm /root/docker/nginx-gateway/conf.d/farm.conf
cd /root/docker/nginx-gateway && docker compose up -d
```
