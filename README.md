# QQ 农场多账号挂机 + Web 面板（个人维护 fork）

> 上游 [liyangpengs/qq-farm-bot](https://github.com/liyangpengs/qq-farm-bot) 已于 **2026-11-25** 宣布停更。
> 本仓库是它在 [XHF-M/qq-farm-bot](https://github.com/XHF-M/qq-farm-bot) 的 fork，继续自用维护。

## 基线

- 上游最后提交：`5049f69f`（含 PR#188 多渠道推送 / 通知类型设置）
- 游戏协议版本：`1.17.0.4_20261117`（QQ / 微信一致）
- 架构：`qq-farm-bot` 主进程 + `session-host` 会话宿主（docker compose 双服务）

## 部署

一键重部署见 [scripts/deploy/README.md](scripts/deploy/README.md)（Windows 下双击 `redeploy.bat`）。
服务器端凭据放在 `scripts/deploy/.deploy.env`，**不入库**。

```bash
docker compose build && docker compose up -d
```

首次启动会创建默认管理员 `admin` / `admin`，面板默认端口 `3007`。对外部署后立即改密码，别把管理端裸奔在公网。

## 文档

- 上游专题文档索引：[docs/README.md](docs/README.md)
- 本 fork 自有改动：[docs/local-changes.md](docs/local-changes.md)
- 代码架构：[docs/code-architecture.md](docs/code-architecture.md)
- 上游同步与推送：[docs/fork-sync.md](docs/fork-sync.md)
