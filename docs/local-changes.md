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

## 活动作物展示补录（红薯 `1020307` / 种子 `20307`）

「以薯换福」的作物由活动临时下发，官方静态表 `Plant.json`（323 种）与
`ItemInfo.json`（1176 项）里都没有 `1020307` / `20307`，于是土地详情出现两处异常：

- 名称退化成 `植物1020307` —— `getPlantName()` 的末位兜底
- `getPlantById()` 未命中 → `seedId = 0` → `seedImage` 为空 → 卡片只剩占位小芽

### 改动

| 路径 | 性质 | 说明 |
| --- | --- | --- |
| `core/src/config/activity-crops.ts` | 新增 | 活动作物补录表（作物 ID ↔ 种子 ID ↔ 名称 ↔ 贴图） |
| `core/src/config/gameConfig.ts` | 挂载点 | `getPlantName()` 缺配置时查补录表 |
| `core/src/services/farm/land-analysis.ts` | 挂载点 | `buildLandDetail()` 补 `seedId` / `seedImage` 兜底 |
| `core/src/gameConfig/seed_images_named/seed_images/20307.png` | 新增 | 红薯贴图（种子 ID） |
| `core/src/gameConfig/seed_images_named/seed_images/1020307.png` | 新增 | 同一张图（作物 ID），沿用官方「一图两名」规则 |
| `core/tests/activity-crop-display.test.js` | 新增 | 3 条：补录表映射、红薯详情、普通作物不受影响 |

### 设计取舍

- **不往 `Plant.json` / `ItemInfo.json` 里加条目**：`getPlantById()` 一旦命中，
  `getAllSeeds()` 就会把活动种子当普通作物暴露给种植策略，可能被自动种植消耗。
  补录表只参与展示，不参与选种。
- 贴图是本地手绘替代。官方 `Crop_307` 贴图需要先拿到 bundle 版本号（见下一节「资源 URL 嗅探代理」），
  抓到后用 `tools/download-game-images.js` 取官方 astc 并转 PNG，再删掉 `activity-crops.ts` 和这两张图。
- `image_phase` 未改：缺 `grow_phases` 时沿用服务端粗状态，与现有兜底一致。

---

## 资源 URL 嗅探代理（2026-11-26）

| 文件 | 状态 | 说明 |
| --- | --- | --- |
| `tools/sniff-asset-urls.js` | 新增 | 自带 MITM 代理，只记录客户端真实请求的资源 URL |
| `docs/tools.md` | 文档 | 新增「用自带代理嗅探资源 URL」一节 |
| `.gitignore` | 修改 | 忽略 `/.capture/`（根证书与 URL 日志） |

### 动机

红薯（`Crop_307`）没有官方贴图，只能手绘。想拿官方图就得先解决「URL 拼不出来」的问题：

```text
<server>/remote/plant/config.<版本hash>.json   → 版本号来自客户端 settings.json
<server>/remote/plant/native/<xx>/<uuid>.<hash>.astc
```

### 实测排除项（别再重复查）

| 尝试 | 结果 |
| --- | --- |
| `remote/plant/config.json` / `version.manifest` / `project.manifest` | 全 404 |
| CDN 目录列举（`?list-type=2&prefix=`） | 只回 `LocationConstraint: ap-nanjing`，无 Key |
| 已知旧版本 `mainscene@47eba` / `extraRes@c384c`（11-01） | 可下载，但早于红薯上线（11-17），无相关资源 |
| 在 `extraRes@c384c` 9227 条路径里搜 red/potato/shu/307 | 只命中松树 `songshu_*` |
| 本机 QQ 小游戏缓存（`cacheList.json` / `gamecaches` / `1112386029`） | 全用户目录均无 |
| 上游 `plant_images/manifest.json`（231 项） | 无 `Crop_307`，且只是导出子集（Plant.json 有 318 作物） |
| 枚举 5 位 hex 版本号 | 13ms/请求，全空间约 234 分钟，放弃 |

结论：**没有一次真实客户端流量就拿不到版本号**，抓包不是可选项而是必要步骤。

### 设计取舍

- **不复用 `core/src/capture`**：那套依赖 `node-forge`、解析 protobuf、带会话管理和 REST API，
  目标是登录 code / 好友 GID。这里只要 URL，独立脚本 300 行零新依赖更合适，也不碰 bot 主流程。
- **证书用 openssl 命令行生成**：Node 无 X.509 签发 API，本机 Git 自带 openssl 3.5.7，
  比引入 `node-forge` 少一个依赖。
- **只记录 URL**：不落盘正文，避免把登录态写进日志。
- 证书一次性生成多 SAN 通配（`*.qq.com` / `*.nqf.qq.com` / `*.qzone.qq.com`），
  避免每域名动态签发。

---

## TS2742 现状（2026-11-26 复核）

`core/src/capture/api-server.js` 已随基线回切删除，`@types/express@^5.0.6` + `express@4`
的声明生成冲突不再存在。复核方式（declaration emit 全量，exit 0）：

```bash
cd core && npx tsc -p tsconfig.json --incremental false
```

新增的 `activity-crops.ts` 所有导出函数都写了显式返回类型，避免同类「推断类型无法命名」。

---

## 统计

```bash
git fetch origin
git log --oneline origin/master..HEAD        # 自有提交数
git diff --stat origin/master..HEAD          # 改动面
```

健康标准：新增文件占绝对多数，修改行数控制在个位数。
