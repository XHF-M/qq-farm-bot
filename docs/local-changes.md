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
| **以薯换福活动（从 muyuewang 备份 tag 摘回并适配官方基线）** | 见 git log | 见下表 | 见下表 | **有源码改动** |

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

## 以薯换福（2026-11-25 ~ 2026-12-09，活动组 `2026111707` / 主模块 `2026111708`）

来源：`tag backup-muyuewang-20261126` 的定制实现，按官方基线 `liyangpengs@5049f69f` 的
`activity-center` + `activity-gameplay-registry` + `web/views/activity-center` 结构重新接线。

### 新增文件

| 路径 | 说明 |
| --- | --- |
| `core/src/services/activity-center/yishuhuanfu.ts` | 活动服务：cmd 91/92/93/95/96/97/98/99 与快照 DTO |
| `core/src/services/yishuhuanfu-auto.ts` | 自动任务（领种子 → 分享暴击 → 比价卖薯 → 领提成），挂在 worker scheduler |
| `core/src/controllers/admin/activity-center/yishuhuanfu-routes.ts` | `/api/activity-center/yishuhuanfu*` 路由 |
| `core/tests/yishuhuanfu-{service,auto,proto}.test.js` | 66 条单测（含抓包 fixture） |
| `web/src/stores/yishuhuanfu.ts` | 前端 store（快照 / 目录 / 记录 / 好友比价） |
| `web/src/components/activity/YishuHuanfuActivityPanel.vue` | 活动详情面板（红薯小铺 / 兑换商店 / 好友比价） |
| `web/src/views/activity-center/YishuHuanfuActivityPage.vue` | 面板的 ActivityShell 壳 |
| `web/tests/yishuhuanfu-store.test.mjs` | store 归一化测试 |
| `web/public/activity-assets/yishuhuanfu/icon.svg` | 活动中心卡片图标 |

### 挂载点（上游重构成新结构后按此重贴）

| 文件 | 改动 |
| --- | --- |
| `core/src/proto/activitypb.proto` | 新增 28 个 `Yshf*` message；`ActivityData` 加 `YshfState yishuhuanfu = 130;`；`ActivityOperateReply` 加 191/192/193/195/196/197/198/199 槽位 |
| `core/src/utils/proto.ts` | `loadProto` 内注册 `Yshf*` 与 `ActivityData` 类型 |
| `core/src/types/config.ts` | `AutomationConfig` 新增 `yishu_*` 10 个字段 |
| `core/src/models/store/shared-state.ts` | 默认值（自动动作全部 `false`，比价上限 20 / 间隔 30min / 起卖 1） |
| `core/src/services/activity-center.ts` | 实例化服务、快照里并入 `yishuHuanfu` + `capabilities`/`actions`/`errors`、导出 10 个方法 |
| `core/src/services/activity-gameplay-registry.ts` | `ActivityDetailTarget` 加 `yishuhuanfu`；适配器 priority 90（最低优先，仅命中 2026111707/08/09） |
| `core/src/core/worker.ts` | 指令分发 10 个 case；`startYishuTimer` 在登录序列与配置变更两处启动 |
| `core/src/runtime/data-provider.ts` | 10 个 worker API 透传 |
| `core/src/controllers/admin/activity-center/index.ts` | 挂载路由 |
| `web/src/stores/activity-center.ts` | `ActivityTabKey`/`ActivityGameplayKey` 加 `yishuhuanfu`；目录归一化优先识别 |
| `web/src/components/activity/gameplays/index.ts` | 注册 `yishuhuanfu` gameplay 与 infer 分支 |
| `web/src/views/ActivityCenter.vue` | 导入并渲染 `YishuHuanfuActivityPage`；打开时跳过通用 `loadDetails` |
| `web/src/views/activity-center/ActivityDirectoryPage.vue` | 卡片图标映射 |
| `web/src/stores/setting.ts` | `AutomationConfig` 前端类型补 `yishu_*` |
| `web/src/components/settings/AutomationSettingsForm.vue` | 「以薯换福」开关组 + 比价参数 + 起卖时间下拉 |

### 相对 muyuewang 的适配差异

- 面板中性色改用设计令牌（`--ui-surface-solid` / `--ui-ink` / `--ui-muted` / `--ui-border`），
  删掉全部 `dark:` 硬编码灰阶，跟随面板主题（深色主题自动生效）。
- 头图按钮（返回/刷新/领提成）从 `BaseButton secondary` 换成半透明白色胶囊，避免浅色按钮压在橙色渐变上不可读。
- 头图日期显示到天（原来带秒，移动端会换行）。
- 好友比价卡片改为等高 + 按钮贴底。
- 未移植 `web/public/activity/card-assets.json` 与旧 `Activity.vue` 卡片背景（旧世代特有），改用新增 SVG 图标。
- 未移植 `farm_illustrated` / `illustrated-automation` 等图鉴自动化定制（与本活动无关）。

### 修复记录

**2026-11-26 活动规则渲染成 `[object Object]`**

- 根因：`yishuhuanfu.ts` 里 `rules: textContent(activity.extra)` 直接把
  `textContent()` 的返回值 `{ title, paragraphs }` 对象下发了；而它自己的
  `web/src/stores/yishuhuanfu.ts` 不做对象归一化（走上游 `activity-center` store
  的活动有 `normalizeRules()` 兜底，以薯换福没走），面板又按 `string[]` 渲染 →
  `String(raw.rules)` → `"[object Object]"` → 页面上只剩一行。
- 后端修法：`rules: textContent(activity.extra).paragraphs`，与其前端渲染口径统一。
- 前端修法：`stores/yishuhuanfu.ts` 新增 `normalizeRules()`，兼容三种形态 ——
  `string[]`、`{ title, paragraphs }`、纯字符串按换行切段。这样即便旧后端仍在跑
  也不会再漏 `[object Object]`（后端改动需要重启 core 才生效，前端 HMR 立即生效）。
- 回归测试：`core/tests/yishuhuanfu-service.test.js` 加 1 条断言 `rules` 为字符串数组；
  `web/tests/yishuhuanfu-store.test.mjs` 加 1 条断言旧结构归一化后不含 `[object Object]`。

**2026-11-26 排查结论：charity / qingmei / qixi / stellar 无需改动**

- 这四处的 `rules: textContent(...)` 是**刻意**的对象结构，不是笔误。链路上三处对齐：
  1. 后端下发 `{ title, paragraphs }`（stellar 的静态目录 `constellation-2026072701.json`
     用 `{ title, lines }`）；
  2. 前端 `stores/activity-center.ts` 的 `normalizeRules()` 同时吃 `paragraphs` 和 `lines`，
     统一产出 `{ title, paragraphs, lines: string[] }`；
  3. 组件 `CharityRedFlowerView` / `QixiActivityView` / `QingMeiBrewTab` /
     `ActivityRulesDialog`（被 `ConstellationTab`、`TravelRulesDialog` 复用）读的都是
     `activity.rules.paragraphs`。
- 以薯换福之所以出事，是因为它没走 `stores/activity-center.ts`，有自己的
  `stores/yishuhuanfu.ts`，而面板按 `string[]` 渲染 —— 两边口径不一致。已在上面修掉。
- 新增 `web/tests/activity-rules.test.mjs`（3 条）锁住这条契约：四个活动 ×
  `{title,paragraphs}` / `{title,lines}` / `rules: null` 三种输入都必须产出可渲染的
  `paragraphs` 且不含 `[object Object]`。

---

## 统计

```bash
git fetch origin
git log --oneline origin/master..HEAD        # 自有提交数
git diff --stat origin/master..HEAD          # 改动面
```

健康标准：新增文件占绝对多数，修改行数控制在个位数。
