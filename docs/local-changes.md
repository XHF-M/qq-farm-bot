# 本地改动台账

记录本 fork 相对上游的所有改动，用于**重放补丁**和**排查回归**。

规则：
- 每新增一个本地功能，在这里加一行，成本 10 秒。
- 「挂载点」写具体文件与行号区域，上游重构后照此重新贴回去。
- 大重构后可整体重排，但不要删除历史条目——改为标注「已上游化」或「已废弃」。

配套方法见 [local-change-guide.md](local-change-guide.md)。

---

## 当前清单

| 功能 | commit | 涉及文件 | 挂载点 | 性质 |
|---|---|---|---|---|
| 代码逻辑总览文档 | `656b7ed` | `docs/code-architecture.md`、`docs/README.md`、根 `README.md` | 无 | 纯新增 |
| 一键部署脚本（Docker + nginx + TLS） | `e6d722f` | `deploy/*`、`.gitignore` | 无 | 纯新增 |
| Fork 同步文档 | 见 git log | `docs/fork-sync.md` | 无 | 纯新增 |
| 本地改动指南 + 台账 | 见 git log | `docs/local-change-guide.md`、`docs/local-changes.md` | 无 | 纯新增 |

> 说明：以上全部为**文档与独立脚本**，没有修改任何上游源码，因此**零冲突风险**。
> 后续新增有代码改动的功能时，请务必填写「挂载点」列。

---

## 统计

```bash
git fetch origin
git log --oneline origin/master..HEAD        # 自有提交数
git diff --stat origin/master..HEAD          # 改动面
```

健康标准：新增文件占绝对多数，修改行数控制在个位数。
