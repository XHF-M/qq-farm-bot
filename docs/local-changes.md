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
| 一键重部署脚本（本机调度 + 服务器构建验证） | 见 git log | `scripts/deploy/*`、`redeploy.bat` | 无 | 纯新增 |
| 上游迁移到 `muyuewang/qq-farm-bot-404` | `9fc8e2b` | 全仓库基线替换；重放上述自有文件 | 无 | **已回退** |
| 修 TS2742：`createCaptureApi` 返回类型注解 | `748ed8f` | `core/src/capture/api-server.js`（函数声明上方 JSDoc） | 随 muyuewang 基线一起移除 | **已废弃** |
| 基线切回 `liyangpengs/qq-farm-bot` 最后版本 | `18d6445` | 全仓库基线替换（`5049f69f`）；重放上述自有文件 | 无 | 基线替换 |

> 说明：除已废弃的 TS2742 补丁外，其余全部为**文档与独立脚本**，没有修改任何上游源码，因此**零冲突风险**。
> 后续新增有代码改动的功能时，请务必填写「挂载点」列。
>
> 2026-11-26 回切后，上游基线为 `liyangpengs/qq-farm-bot` 的 `master` @ `5049f69f`
> （作者已于 2026-11-25 宣布停更）。备选分支 `muyuewang/qq-farm-bot-404` 的定制
> （以薯换福、图鉴自动化、精简架构）**未并入**。
> 迁移细节见 [fork-sync.md](fork-sync.md#上游迁移记录)。
>
> **TS2742 补丁（已废弃）**：当时上游 `core/package.json` 声明 `@types/express@^5.0.6`，运行时是 `express@4`，
> `tsc` 生成 `.d.ts` 时无法命名 `express-serve-static-core` 的推断类型导致构建中断。
> 该文件（`core/src/capture/api-server.js`）只存在于 muyuewang 分支，回切后无需此补丁。

---

## 统计

```bash
git fetch origin
git log --oneline origin/master..HEAD        # 自有提交数
git diff --stat origin/master..HEAD          # 改动面
```

健康标准：新增文件占绝对多数，修改行数控制在个位数。
