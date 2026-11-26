# Fork 同步与推送

本仓库跟随 [muyuewang/qq-farm-bot-404](https://github.com/muyuewang/qq-farm-bot-404) 更新，
自有改动推送到 [XHF-M/qq-farm-bot](https://github.com/XHF-M/qq-farm-bot)。
GitHub 的 fork **不会**自动跟随上游，需要手动同步。

> 2026-11-26 上游迁移：原上游 `liyangpengs/qq-farm-bot` 已停更，改用同源 fork
> `muyuewang/qq-farm-bot-404`（`main` 分支）。两者的历史提交 hash 不共享，
> 因此切换时采用的是「基线替换 + 重放本地文件」，不是 `merge`。详见文末「上游迁移记录」。

## remote 布局

| remote | 地址 | 用途 |
| --- | --- | --- |
| `origin` | `git@github.com:liyangpengs/qq-farm-bot.git` | 旧上游，已停更，只作历史参考 |
| `muyuewang` | `https://github.com/muyuewang/qq-farm-bot-404.git` | **当前上游**（`main`），只 `fetch`，不要直接推 |
| `fork` | `git@github.com:XHF-M/qq-farm-bot.git` | 自己的 fork，所有推送目标 |

确认现状：

```bash
git remote -v
git branch -vv
```

## 日常同步（上游有新提交时）

以下命令均在仓库根目录执行：

```bash
git fetch muyuewang                                  # 拉上游，不改工作区
git log --oneline HEAD..muyuewang/main               # 看上游新增了哪些提交
git merge muyuewang/main                             # 合并到本地 master
git push fork master                                 # 推到自己的 fork
```

一行版本：

```bash
git fetch muyuewang && git merge muyuewang/main && git push fork master
```

> 必须用 `merge`，**不要用 `reset --hard`**。fork 上有自有提交（文档、部署脚本），
> reset 会把它们直接抹掉。

## 只看有没有更新

```bash
git fetch muyuewang && git rev-list --count HEAD..muyuewang/main
```

- 输出 `0`：上游没有新提交，不用同步。
- 输出 `3`：上游有 3 个新提交待合并。

## 只推本地改动（不需要合并上游）

```bash
git add <文件>
git commit -m "类型: 说明"
git push fork master
```

## 冲突处理

`git merge` 报冲突时，先看哪些文件：

```bash
git status
```

逐个改完冲突标记后：

```bash
git add <解决完的文件>
git merge --continue
git push fork master
```

放弃这次合并、回到合并前的状态：

```bash
git merge --abort
```

## 网页方式（应急）

打开 `https://github.com/XHF-M/qq-farm-bot`，页面顶部提示
`This branch is N commits behind muyuewang:main` 时点 **Sync fork** → **Update branch**。

有冲突时网页无法自动合并，会提示你需要手动处理，此时回到本地按上面的冲突处理流程走。

## 常见错误

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `! [rejected] master -> master (fetch first)` | fork 上有网页端产生的提交 | `git pull fork master` 合并后再推 |
| `Permission denied (publickey)` | SSH key 不是 `XHF-M` 的身份 | `ssh -T git@github.com` 看返回的用户名 |
| 推上去了但 GitHub 页面没变 | 推的是 `origin` 而不是 `fork` | `git remote -v` 核对，push 时显式写 `fork` |
| 合并后代码跑不起来 | 上游改了依赖或配置格式 | 重新 `pnpm install`，再 `pnpm build` |

## 提交前检查清单

1. `git status` 确认没有把运行数据、日志、`.workbuddy/` 带进去（已在 `.gitignore` 中忽略）。
2. 不要在脚本默认值里写真实域名、服务器地址或凭据，用 `example.com` 之类的占位符。
3. `git diff` 通读一遍再 commit。

## 上游迁移记录

### 2026-11-26：`liyangpengs/qq-farm-bot` → `muyuewang/qq-farm-bot-404`

原上游停更。新上游是同源 fork，分支为 `main`，已包含旧上游 PR#187 及之后的「以薯换福」活动。

两边**不共享提交 hash**（新上游把旧提交重新落了一遍），`git merge-base` 停在 PR#134，
直接 `merge` 会产生大量假冲突。因此采用基线替换：

```bash
git tag backup-<日期> master                  # 先打备份
git fetch muyuewang --no-tags                 # 拉新上游（仓库大，耐心等）
git reset --hard muyuewang/main               # 切到新基线
git checkout -- .                             # 必做：Windows 下 reset 可能漏写文件
git checkout backup-<日期> -- deploy/ scripts/deploy/ redeploy.bat docs/<本地文档>.md
# 再手工把 .gitignore / README.md / docs/README.md 的本地增量贴回
git commit -m "chore: 切换上游"
git push --force-with-lease fork master       # 历史重写，必须 force
```

重放清单（本仓库自有、上游没有的文件）：

| 路径 | 说明 |
| --- | --- |
| `deploy/` | Docker + nginx + TLS 一键部署脚本 |
| `scripts/deploy/` | 重部署脚本（`redeploy.py` / `redeploy.sh`） |
| `redeploy.bat` | Windows 双击入口 |
| `docs/code-architecture.md`、`docs/fork-sync.md`、`docs/local-change-guide.md`、`docs/local-changes.md`、`docs/ranch-automation-20261116.md` | 本地专题文档 |

另：`scripts/deploy/.deploy.env`（明文服务器凭据）在 `reset` 时会被连同目录一起删掉，
升级前先备份到 `.workbuddy/deploy/.deploy.env`，或直接从该处复制回来。

服务器端同步方式不变：`git remote set-url origin https://github.com/XHF-M/qq-farm-bot.git`，
`BRANCH` 保持 `master`。
