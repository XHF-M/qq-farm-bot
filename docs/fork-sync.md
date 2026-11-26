# Fork 同步与推送

本仓库是 [liyangpengs/qq-farm-bot](https://github.com/liyangpengs/qq-farm-bot) 的 fork，
自有改动推送到 [XHF-M/qq-farm-bot](https://github.com/XHF-M/qq-farm-bot)。
GitHub 的 fork **不会**自动跟随上游，需要手动同步。

## remote 布局

| remote | 地址 | 用途 |
| --- | --- | --- |
| `origin` | `git@github.com:liyangpengs/qq-farm-bot.git` | 上游，只 `fetch`，不要直接推 |
| `fork` | `git@github.com:XHF-M/qq-farm-bot.git` | 自己的 fork，所有推送目标 |

确认现状：

```bash
git remote -v
git branch -vv
```

## 日常同步（上游有新提交时）

以下命令均在仓库根目录执行：

```bash
git fetch origin                          # 拉上游，不改工作区
git log --oneline HEAD..origin/master     # 看上游新增了哪些提交
git merge origin/master                   # 合并到本地 master
git push fork master                      # 推到自己的 fork
```

一行版本：

```bash
git fetch origin && git merge origin/master && git push fork master
```

> 必须用 `merge`，**不要用 `reset --hard`**。fork 上有自有提交（文档、部署脚本），
> reset 会把它们直接抹掉。

## 只看有没有更新

```bash
git fetch origin && git rev-list --count HEAD..origin/master
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
`This branch is N commits behind liyangpengs:master` 时点 **Sync fork** → **Update branch**。

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
