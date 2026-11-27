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
- 贴图最初是本地手绘替代；2026-11-27 已换成**官方贴图**（从手机缓存取 `Crop_307_Seed` 的 astc 解码，
  见「官方贴图（已拿到）」一节与 `docs/asset-from-phone-cache.md`）。
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

## 活动道具名称/贴图补录（红薯种子 / 红薯 / 黄金·红薯）

配套上一节：作物侧修好后，**背包（批量出售）**里仍然出现三张一眼假的卡：

```text
物品20307   （有图，因为 20307.png 已在本地，但名字没兜底）
物品40307   ×5 张（含变异·迷藏/爱心/冰冻），无图 → 「物」占位
物品1040307 ×2 张（变异·黄金），无图 → 「物」占位
```

根因同一条：这三个 ID 都不在 `ItemInfo.json` 里，而所有「按 ID 查名字/图标/分类」的
调用点都走 `getItemById()` / `getItemImageById()`，取不到就各自兜成 `物品${id}`、空图。

### 改动

| 路径 | 性质 | 说明 |
| --- | --- | --- |
| `core/src/config/activity-crops.ts` | 扩展 | 新增 `ActivityItemOverride` + `ACTIVITY_ITEM_LIST`；作物补录加 `fruitId` / `goldenPlantId` / `goldenItemId` / `goldenName` |
| `core/src/config/gameConfig.ts` | 挂载点 | `getItemById()` 查不到时返回合成的 `ItemInfo`；`getItemImageById()` 末尾回落到补录图；`getPlantNameBySeedId()` / `getFruitName()` 各自接补录表；`getMutantDisplayPlantId()` 补「活动作物 + 变异 5 → 黄金版作物」映射 |
| `core/src/gameConfig/seed_images_named/seed_images/40307.png` | 新增 | 红薯果实图（复用 1020307.png 的画） |
| `core/src/gameConfig/seed_images_named/seed_images/1040307.png` | 新增 | 黄金·红薯图（由 1020307.png 做金属金调色） |
| `core/tests/activity-crop-display.test.js` | 扩展 | 断言三件道具的 name/type/image 与黄金作物名映射，并锁住「活动种子不进 getAllSeeds」 |

### 关键取舍

- **在 `getItemById()` 里兜，而不是逐个 DTO 改**：背包、仓库、活动中心、礼包、赠送
  一共 60+ 个调用点都读 `getItemById(id)?.name`，集中兜一次全部生效，也不会漏。
- **合成条目 `sells: null`**：活动道具的售价只认服务端协议下发，不给本地配置凭空
  开一个出售入口（`getEffectiveSellInfo` 因此返回 `unavailable`，与原行为一致）。
- **`type` 必须填对**：背包按 `itemType` 分「果实 / 超变果实 / 种子」三个 Tab，
  填 6 / 17 / 5 之后分类、可锁定、排序全部自动正确。
- **`getAllSeeds()` 仍然不含活动种子**：补录只进 `activityItemInfoMap`，不进
  `seedToPlant`，自动种植策略不会去消耗活动种子。

### 复核

```bash
cd core && npx tsc --noEmit && npx tsc && node --test tests/activity-crop-display.test.js
```

DTO 层可直接用假 `BagReply` 跑一遍（不需要登录），预期输出：

```text
   40307 红薯        | category fruit  | type 6  | image .../40307.png
 1040307 黄金·红薯   | category mutant | type 17 | image .../1040307.png
   20307 红薯种子     | category seed   | type 5  | image .../20307.png
```

---

## 活动作物参与自动种植（红薯种子 20307）

上一节只修了「能看见」，这一节修「能种」：背包里有红薯种子，但自动种植始终不种。

### 根因

`services/warehouse.ts` 的 `getBagSeeds()` 用作物配置过滤背包：

```ts
const plant = getPlantBySeedId(seedId);
if (!plant) continue;        // ← 20307 在 Plant.json 里没有，直接丢弃
```

红薯是活动作物，由服务端下发，永远不在 `Plant.json` 里，所以这一步就被静默过滤掉了，
后面的优先级排序、地块匹配、种植请求根本轮不到它。

### 改动

| 路径 | 性质 | 说明 |
| --- | --- | --- |
| `core/src/config/activity-crops.ts` | 扩展 | `ActivityCropOverride` 增加 `size` / `landLevelNeed`；新增 `getActivityCrops()`、`isActivitySeed()` |
| `core/src/config/gameConfig.ts` | 挂载点 | 新增 `activityPlantMap` + `registerActivityPlants()`，`getPlantBySeedId()` 查不到官方配置时返回合成 Plant；导出 `isActivitySeed` |
| `core/src/services/farm/planting.ts` | 排序 | `sortBagSeedsForPlanting()` 让未配置优先级的活动种子排在「显式优先级之后、其他种子之前」 |
| `core/tests/activity-crop-planting.test.js` | 新增 | 用假 `BagReply` 跑真实 `getBagSeeds()`，锁住「红薯种子可种、果实不误判」 |

### 关键取舍

- **合成 Plant 只放进 `activityPlantMap`，不进 `seedToPlant`**：`getAllSeeds()` 仍只读 `Plant.json`，
  商店兜底列表、图鉴、培育策略不会被活动种子污染。
- **种植请求只发 `seedId` + `landIds`**（服务端校验），本地只需 `size` 用于地块布局，故 `size` 缺省 1、
  `landLevelNeed` 缺省 0，不编造未知的生长参数。
- **排序策略**：活动有时限，留在背包会作废，所以未显式配置优先级时排在普通种子前面；
  用户在设置里配了种子优先级的，仍以用户配置为准（活动种子排在显式列表之后）。

### 复核

```bash
cd core && npx tsc --noEmit && npx tsc && node --test tests/activity-crop-planting.test.js
```

预期：

```text
--- getPlantBySeedId ---
20307 => name=红薯 size=1 landNeed=0 fruit=40307
--- getBagSeeds（真实逻辑 + 假协议）---
   20307 红薯 x5 lv0 size1
   20002 白萝卜 x12 lv1 size1
红薯种子被识别为可种: true
果实 40307 未被误判为种子: true
```

### 官方贴图（已拿到，2026-11-27）

背包图标与种子的资源名按官方命名规律可确定：

```text
40307 / 20307  -> asset_name = Crop_307
1040307        -> asset_name = gold/Crop_307    （对照 40304=Crop_304、1040304=gold/Crop_304）
```

**落地方式：不抓包，直接从手机缓存取**（完整流程见 `docs/asset-from-phone-cache.md`）。

微信小游戏把 Cocos bundle 明文缓存在
`/sdcard/Android/data/com.tencent.mm/MicroMsg/wxanewfiles/<账号hash>/gamecaches/plant/`：

- manifest（`paths` / `uuids` / `versions`）是明文 JSON，可查到 `Crop_307_Seed` 的 uuid 与 hash
- 贴图是 `*.astc`，用 `astcenc -dl` 解码
- 红薯种子图缓存文件：`1795661844979146.astc`（100×100）

已替换的贴图：

| 文件 | 来源 |
|---|---|
| `20307.png` | 官方 `Crop_307_Seed` 原图（100×100） |
| `40307.png` | 同上 |
| `1020307.png` | 同上（田间作物图集本次未进缓存，暂用种子图） |
| `1040307.png` | 官方图做金色调色（保留官方边线和光晕） |

#### 旧思路（走不通，留作记录）

`plant` bundle 的 `model/v4/...` 资源拿不到，因为 bundle 版本号只在客户端 `settings.json`，
而 CDN 的 `remote/<bundle>/native/**` 全部 404（有防盗链），只有 `config.<hash>.json` 可下载。

抓包这条路在未 root 的 Android 上行不通：Android 7+ 的 App 默认只信任系统 CA，
微信原生网络栈不信任用户安装的证书，Fiddler 只能看到 CONNECT 隧道。

```bash
# 只下这 3 张：造一个只含活动条目的临时配置目录，避免重下 1400+ 张既有图
mkdir -p .tmp-activity-cfg
cat > .tmp-activity-cfg/ItemInfo.json <<'EOF'
[{"id":20307,"asset_name":"Crop_307"},{"id":40307,"asset_name":"Crop_307"},{"id":1040307,"asset_name":"gold/Crop_307"}]
EOF
echo '[]' > .tmp-activity-cfg/Plant.json

node tools/download-game-images.js \
  --input .tmp-activity-cfg \
  --output core/src/gameConfig/seed_images_named/seed_images \
  --cdn-server https://cdn-resource.nqf.qq.com/release/ \
  --bundle-version plant=<抓包得到的版本>
```

也可以在读取真实 `ItemInfo.json` 时用 `--extra-items "20307:Crop_307,40307:Crop_307,1040307:gold/Crop_307"`
补条目——但那样会把既有 1400+ 张图一起重下，只有需要全量刷新时才划算。

`--extra-items` 是本轮给工具新增的参数，格式 `<id>:<asset_name>`，逗号分隔。

---

## 活动种子进入「优先种植种子」下拉

上一节让红薯种子能种了，但用户没法指定「优先种它」：设置页的「优先种植种子」
下拉数据源是 `/api/seeds`（`getAvailableSeeds()`），而它只遍历种子商店货架，
活动种子买不到、自然不在列表里。

### 改动

| 路径 | 性质 | 说明 |
| --- | --- | --- |
| `core/src/services/farm/planting.ts` | 扩展 | `getAvailableSeeds()` 末尾追加活动种子条目（`purchasable:false` / `goodsId:0` / `price:null` / `activity:true`），并让它们固定排在商店种子之后 |
| `web/src/views/Settings.vue` | 展示 | `SeedOptionItem` 增加 `purchasable`/`activity`；`preferredSeedOptions` 把活动种子显示为「红薯（活动·仅背包）」，纯商店策略下不展示；`strategyPreviewLabel` 不再拼「0级」 |
| `core/tests/activity-crop-planting.test.js` | 扩展 | 补 2 条：`/api/seeds` 附带不可购买的活动种子且排最后；显式优先级能把红薯排到背包顺序第一位 |

### 生效路径

```
设置页「优先种植种子」选 红薯
  → handlePreferredSeedChange() → sortBagSeedsByFallbackStrategy('preferred')
  → bagSeedPriority 里 20307 排第一
  → plantFromBagSeeds() 按该顺序消耗背包种子
```

注意只有 **种植策略 = 背包种子优先**（`bag_priority`）时才展示活动种子：
纯商店策略（`preferred`）走 `findBestSeed()` 买种子，活动种子不可购买，
放进去只会变成「选了没反应」的假选项。

---

## 官方配置与贴图对齐（2026-11-27）

### 动机

手机缓存（`.capture/phone/`，见 `docs/asset-from-phone-cache.md`）里有比仓库更新的官方资源：
plant bundle 的 131 张 astc 贴图、mainscene 里的配置 TextAsset。上一轮只把红薯一株手工补进去了，
这次把「能官方化的部分」全部对齐。

### 关键发现：配置不是靠猜的

`mainscene` 里的 `Plant` / `ItemInfo` 是 `cc.TextAsset`，`text` 字段 base64 后熵 6.9 —— 加密过的，
解不开。但**上游仓库 `muyuewang/main` 已经有新配置**，直接对齐比逆向加密省事得多：

```
git fetch muyuewang main
git show FETCH_HEAD:core/src/gameConfig/EventPlants.json
```

`EventPlants.json` 是官方的**活动 / 节令作物表**，仓库里一直缺这个文件。字段是平铺的
（`fruit_id` / `fruit_count`），并且带 `asset_name`（如 `Crop_307`）—— 这正是贴图资源名。

```json
{"id":1020307,"seed_id":20307,"fruit_id":40307,"asset_name":"Crop_307","name":"红薯"}
```

### 改动

| 文件 | 内容 |
|---|---|
| `core/src/gameConfig/ItemInfo.json` | 同步上游，+5 条：`1032 蜜薯`、`1033 福气币`、`20307 红薯种子`、`40307 红薯`、`1040307 黄金·红薯`（其余 1176 条逐字节未变） |
| `core/src/gameConfig/EventPlants.json` | 新增，34 条活动作物；其中 `1020307 红薯`、`1020207 绣球花`、`1060032 金盏花` 是 `Plant.json` 里没有的 |
| `core/src/config/gameConfig.ts` | 新增 `eventPlantMap` / `eventSeedToPlant` / `eventFruitToPlant` / `eventAssetNameMap`；`loadConfigs()` 里加载 EventPlants；新增 `findPlant()` 统一「主表 → 活动表」查找，`getPlantById` / `getPlantName` / `getPlantGrowTime` / `getPlantGrowPhases` / `getPlantExp` 全部改用它 |
| 贴图 16 组（48 个 png） | `20522 20523 20525 20526 20527 20528 20529 20530 29003 29005 21435 20129 20121 20109 20021 20416` 换成官方新版，种子/果实/作物三个文件名同步 |

### 关键取舍

**EventPlants 不并入 `seedToPlant`。** 并进去 `getAllSeeds()` 就会把限时活动种子当成常驻商店
商品暴露给种植策略，可能触发买不到的购买请求。只在 `findPlant` / `getPlantBySeedId` 做兜底。

**只换 diff > 10 的贴图。** 用「项目旧图 ↔ 官方解码图」的内容距离筛：
- `<= 3`：同一张图，只是 ASTC 有损压缩的差别 → 不覆盖（项目里的无损 PNG 质量更好）
- `3 ~ 10`：图案一致，构图/色差毫厘 → 不覆盖，同上
- `> 10`：美术改版 → 覆盖

16 组全部肉眼核对过是同一作物的新旧两版（例如 `20527 森野甜橙` 旧版是切开的橙子、新版是整颗 + 金色版）。

**作物生长参数拿不到。** EventPlants 里活动作物只有骨架字段（id / seed_id / fruit_id / asset_name / name），
没有 `grow_phases` / `exp` / `fruit_count`。这些由服务端下发，配置里本来就没有，展示成 0 与原补录表一致，不算退化。

### 复核

```bash
node --test core/tests/activity-crop-*.test.js     # 11 项全过
node --test core/tests/*.test.js                   # 372 项，17 失败（均为既有，与本改动无关）
```

```js
// dist 下实际验证
const g = require('./core/dist/config/gameConfig');
g.getPlantName(1020307);            // '红薯'（来自 EventPlants）
g.getPlantBySeedId(20307).grow_phases; // ''（官方未下发）
g.getAllSeeds().some(s => s.seedId === 20307); // false，没污染商店列表
g.getItemById(40307).name;          // '红薯'（来自 ItemInfo）
```

---

## 统计

```bash
git fetch origin
git log --oneline origin/master..HEAD        # 自有提交数
git diff --stat origin/master..HEAD          # 改动面
```

健康标准：新增文件占绝对多数，修改行数控制在个位数。
