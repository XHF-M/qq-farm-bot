# Fork 同步与推送

本仓库 fork 自 [liyangpengs/qq-farm-bot](https://github.com/liyangpengs/qq-farm-bot)，
自有改动推送到 [XHF-M/qq-farm-bot](https://github.com/XHF-M/qq-farm-bot)。
GitHub 的 fork **不会**自动跟随上游，需要手动同步。

> **上游状态：2026-11-25 作者宣布停更**，README 已改为「停更了」，代码停在
> `5049f69f`（含 PR#188 多渠道推送 / 通知类型设置）。当前本仓库就是这个基线，
> 协议版本 `1.17.0.4_20261117`。

## remote 布局

| remote | 地址 | 用途 |
| --- | --- | --- |
| `origin` | `git@github.com:liyangpengs/qq-farm-bot.git` | 上游（已停更），只 `fetch` 作参考 |
| `fork` | `git@github.com:XHF-M/qq-farm-bot.git` | 自己的 fork，所有推送目标 |
| `muyuewang` | `https://github.com/muyuewang/qq-farm-bot-404.git` | 备选分支（`main`），含「以薯换福」等定制，暂无跟踪 |

确认现状：

```bash
git remote -v
git branch -vv
```

## 上游若恢复更新

```bash
git fetch origin                        # 拉上游，不改工作区
git log --oneline HEAD..origin/master   # 看新增了哪些提交
git merge origin/master                 # 合并（本仓库历史已与上游对齐，可以正常 merge）
git push fork master
```

一行版本：

```bash
git fetch origin && git merge origin/master && git push fork master
```

> 本仓库基线就是上游 `5049f69f` 的直接后代，**可以正常 merge**，不需要再做基线替换。

## 只看有没有更新

```bash
git fetch origin && git rev-list --count HEAD..origin/master
```

- 输出 `0`：上游没有新提交。
- 输出 `3`：上游有 3 个新提交待合并。

## 只推本地改动

```bash
git add <文件>
git commit -m "类型: 说明"
git push fork master
```

## 冲突处理

```bash
git status                    # 看冲突文件
# 改完冲突标记后
git add <解决完的文件>
git merge --continue
git push fork master
```

放弃本次合并：`git merge --abort`。

## 网页方式（应急）

打开 `https://github.com/XHF-M/qq-farm-bot`，顶部提示
`This branch is N commits behind liyangpengs:master` 时点 **Sync fork** → **Update branch**。
有冲突时网页无法自动合并，回本地走上面的流程。

## 常见错误

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `! [rejected] master -> master (fetch first)` | fork 上有网页端产生的提交 | `git pull fork master` 合并后再推 |
| `Permission denied (publickey)` | SSH key 不是 `XHF-M` 的身份 | `ssh -T git@github.com` 看返回的用户名 |
| 推上去了但 GitHub 页面没变 | 推的是 `origin` 而不是 `fork` | `git remote -v` 核对，push 时显式写 `fork` |
| `fetch` 成功但 `origin/master` 没更新 | 本机 git 写 ref 偶发失败（packed-refs 未覆盖） | 直接写 `.git/refs/remotes/origin/master` 文件，或用 sha 操作 |
| 合并后代码跑不起来 | 上游改了依赖或配置格式 | 重新 `pnpm install`，再 `pnpm build` |

## 提交前检查清单

1. `git status` 确认没有把运行数据、日志、`.workbuddy/` 带进去（已在 `.gitignore` 中忽略）。
2. 不要在脚本默认值里写真实域名、服务器地址或凭据，用 `example.com` 之类的占位符。
3. `git diff` 通读一遍再 commit。

## 上游迁移记录

### 2026-11-26（第二次）：`muyuewang/qq-farm-bot-404` → `liyangpengs/qq-farm-bot`

muyuewang 分支是精简定制版（去掉 `session-host` 多进程、`release-manager` / `system-update`，
加了「以薯换福」），与官方主线不是同一世代。决定回到官方最后版本：

```bash
git tag backup-muyuewang-20261126 master
git fetch https://github.com/liyangpengs/qq-farm-bot.git master:refs/remotes/origin/master
git reset --hard 5049f69f          # 上游最后提交
git checkout -- .                  # Windows 下 reset 会漏写文件，必须补
git checkout backup-muyuewang-20261126 -- deploy scripts/deploy redeploy.bat \
  docs/code-architecture.md docs/fork-sync.md docs/local-change-guide.md \
  docs/local-changes.md docs/ranch-automation-20261116.md
git push --force-with-lease fork master
```

代价（回切后没有的）：以薯换福活动、图鉴自动化、精简版页面。
收益：PR#135~#188 全量功能、多渠道推送、`release-manager` / `system-update`、活动中心完整页。

### 2026-11-26（第一次）：`liyangpengs/qq-farm-bot` → `muyuewang/qq-farm-bot-404`

（已回退，仅存档）当时判断上游停更，切到 muyuewang 的 `main`。两边不共享提交 hash，
`merge-base` 停在 PR#134，所以采用基线替换 + 重放本地文件。

重放清单（本仓库自有、上游没有的文件）：

| 路径 | 说明 |
| --- | --- |
| `deploy/` | Docker + nginx + TLS 一键部署脚本 |
| `scripts/deploy/` | 重部署脚本（`redeploy.py` / `redeploy.sh`） |
| `redeploy.bat` | Windows 双击入口 |
| `docs/code-architecture.md`、`docs/fork-sync.md`、`docs/local-change-guide.md`、`docs/local-changes.md`、`docs/ranch-automation-20261116.md` | 本地专题文档 |

## 服务器端注意

- 服务器仓库 `origin` 用 **HTTPS**（`https://github.com/XHF-M/qq-farm-bot.git`），
  服务器上没有 GitHub 部署密钥，用 SSH 会 `Permission denied`。
- `scripts/deploy/.deploy.env`（明文服务器凭据）在 `reset --hard` 时会随目录被删，
  升级前先备份到 `.workbuddy/deploy/.deploy.env`。
- `docker-compose.override.yml` 是服务器本地文件（不入库）：清空宿主机端口映射、
  只暴露 3007 给 nginx-gateway、给两个服务设 `mem_limit`。
