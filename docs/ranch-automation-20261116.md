# 牧场玩法自动化：评估与实施方案（历史存档）

> ⚠️ **本文已过时。上游已在 `6ac7a3d`（2026-11-17）完整实现牧场自动化。**
>
> 当时的结论「数据齐、协议缺」已不成立——上游补齐了协议与整套实现。现状参考：
>
> | 内容 | 位置 |
> |---|---|
> | 协议 | `core/src/proto/ranchpb.proto`、`core/src/proto/animalpb.proto` |
> | 牧场配置 | `core/src/gameConfig/ranch/MC*.json`（动物/变异/罐头/设施/任务/重量档） |
> | 业务模块 | `core/src/services/ranch/`（13 文件，约 1700 行） |
> | 自动化开关 | `core/src/config/ranch-automation.ts`（22 项，默认全关） |
> | 前端 | `web/src/views/Ranch.vue`、`web/src/views/RanchOverview.vue`、`web/src/components/ranch/*` |
>
> 保留本文的价值：**分阶段落地路径、风控建议、以及「哪些坑当时无法判断」**——这部分结论在实现后仍然成立。
>
> 原始状态：仅调研与方案，未写任何代码。结论基于 2026-11-16 的仓库代码（上游 `b3c1020`）与游戏配置快照。

## 一、结论

**技术上可做，但有一个硬前置：牧场协议尚未存在。**

现在的仓库处于「**数据齐、协议缺**」的状态：

- 游戏静态配置里**牧场玩法已经完整下发**（24 种动物、产物、货币、饲料、加速道具、图鉴分类全在），说明官方资源已铺好，玩法定档。
- `core/src/proto/` 39 个 proto 文件里**没有任何牧场相关的 message 或 service**，连 `animal`/`ranch`/`pasture` 字样都没有（唯一命中是 `pet-diary.proto` 的宠物寻宝喂食，无关）。

也就是说：**能不能做，取决于能不能先拿到牧场的 `service.method` 与 message 定义**。拿到之后，按现有架构接入是常规工作量（参照宠物玩法，全链路约 800 行；带自动循环 + 开关 + 面板约 1500-2500 行）。

## 二、现状盘点（带证据）

### 2.1 数据侧：已就绪

`core/src/gameConfig/ItemInfo.json` 共 1066 条物品，其中 `bundle_name == "animal"` 的 83 条构成完整牧场体系：

| type | 含义 | 数量 | 样例（id） |
|---|---|---|---|
| 105 | 动物幼崽 | 24 | 鸡 `60001`、兔 `60002`、鹅 `60003`、牛 `70002` |
| 106 | 成熟动物（可收获出售） | 24 | 整鸡 `2060001`、整牛 `2060002` |
| 107 | 持续产物 | 24 | 鸡蛋 `1060001`、牛奶 `1070002` |
| 108 | 便便（好友牧场清理获得） | 1 | `7002` |
| 109 | 罐头（产出加速，1/4/8/12 小时） | 8 | `80021`~`80024` |
| 101 | 牧草（饲料） | 1 | `7001` |
| 3 | 牧场经验 | 1 | `1102` |
| 102 | 金券（牧场专属货币） | 1 | `1007` |

从配置能反推出的玩法模型：

- **动物分两类栏舍**：`6xxxx` 系列描述为「放进牧场的**窝**里饲养」（鸡/兔/鹅/猫…），`7xxxx` 系列为「**棚**里饲养」（羊/牛/猴/猪…）。
- **`layer` 字段取值 1-6，每种档位各 4 只动物** → 对应 6 段牧场等级解锁区间；动物自身 `level` 从 1 到 47 覆盖全周期。
- **经济闭环**：金券（1007）→ 买幼崽/饲料 → 养大 → 收产物（107）卖金券 / 收成熟体（106）卖金券 → 得牧场经验（1102）→ 升等级解锁更贵动物。
- **饲料是瓶颈**：牧草（7001）描述明确「可以在农场种植，也可在饲料商店购买。**牧草耗尽时，动物会暂停成长**」。这条把牧场和现有种植系统耦合起来了。
- **社交链路**：便便（7002）「去好友牧场帮忙清理可获得，出售可换取金券」—— 对应现有偷菜/帮好友的自动化模式。

同步佐证：`Illustrated.json` 已含「牧场图鉴」「牧场主产物」两个分类，说明图鉴侧也已铺好。

### 2.2 数据侧唯一缺口

`core/src/gameConfig/Plant.json` 的 318 种作物里**没有牧草**。两种可能：

1. 该快照取自牧场上线前的客户端（最可能，因为 `ItemInfo.json` 已含牧场而它是同批下载的，说明两张表版本不同步）；
2. 牧草走独立种植体系（草场），不复用 `Plant.json`。

**待验证**：牧场上线后重跑 `tools/download-game-config.js` 拉全量配置（`allconfig` 模式会枚举 bundle 内全部资源），看是否出现 `Animal.json` / `Pasture.json` / `Grass.json` 这类独立表。这个工具支持按资源名或全量 dump，零成本。

### 2.3 协议侧：完全缺失

`core/src/proto/` 全部 39 个文件 close-reading 结果：

- `corepb.proto`（53 行）只有 `Item`/`ItemBag`/`ItemChg`
- `plantpb.proto` 是土地/种植，`itempb.proto` 是背包
- `game.proto`（1-45 行）只是 `gatepb` 外壳

协议命名规范是 `gamepb.<domain>pb.<Domain>Service` + method 字符串（见 `core/src/services/farm/api.ts:31` 的 `sendMsgAsync('gamepb.plantpb.PlantService', 'Harvest', body)`）。牧场大概率落在 `gamepb.animalpb.AnimalService` 或 `gamepb.pasturepb.PastureService`，**但名字猜不出来 —— 猜错的表现只是超时，不报错**，所以必须实测。

## 三、协议怎么补（P0，唯一的关键路径）

项目已有工具链，但只能解「已知类型」，新玩法要人工逆推：

- `tools/decode-latest-protocols.js`：读 `.bin` WebSocket 帧，按 `gatepb.Message` 解外层，**能保留未匹配类型的原始 protobuf 字段**（`--shape` / `--all` 参数）。这就是逆推牧场 message 的入口。
- `tools/download-game-config.js`：从游戏 CDN 拉配置，能按资源名或全量 dump。
- 现有 proto 是**手工整理**的，没有生成脚本（`docs/tools.md:166-207` 只写了用法，没写 codegen）。这意味着新协议要靠「抓包 → 比对字段 → 手写 .proto → roundtrip 校验」。

### 抓包清单（需要你配合做的唯一一件事）

用手机连代理抓 QQ/微信农场的 WS 帧，在牧场里**完整走一轮**，每个动作单独做一次、中间停顿 3 秒以上，方便按顺序切分：

1. 首次进牧场（最关键的初始状态拉取）
2. 买一只幼崽
3. 把幼崽放进窝
4. 投喂牧草
5. 等成熟 → 收产物
6. 收成熟体（如果有「收获」动作）
7. 出售产物换金券
8. 去好友牧场 → 清理便便
9. 用一次罐头
10. 点一下牧场升级/扩建

拿到抓包目录后跑：

```bash
pnpm -C core exec node ../tools/decode-latest-protocols.js "D:\path\to\captures" --all --shape
```

这一步能确定：service 名、method 名、request/response 字段全貌。**风险**：抓包含 Token 与账号凭据，分析前先存副本、输出前清理。

### 备选路径（更快但不确定）

游戏是 Cocos Creator 打包，proto 定义可能以 `pbjs` 静态代码或 `.proto` 文本形式存在于 bundle 的 JS/WASM 里（现有 proto 大概就是这么来的）。若能从客户端包直接提取，可跳过抓包。**建议先花半天翻客户端资源，失败再走抓包。**

## 四、实现方案

### 4.1 架构落点：独立模块，不要塞进 `runFarmTick`

现有主循环 `core/src/core/worker.ts:270-296` 的 `runFarmTick` 是**固定串行**执行（`auto.farm` → `auto.task` → 邮箱 → 肥料礼包），且 farm 班次在途上限只有 1、下一轮间隔在 `finally` 里才重算。**把牧场塞进去会让牧场耗时直接推迟巡田**，不值。

推荐：

```ts
// 仿 services/farm/，新建独立子模块
core/src/services/ranch/
  api.ts          // 纯 RPC 编解码，无业务判断（参照 farm/api.ts 295 行的风格）
  state.ts        // 牧场快照解析（窝/棚列表、动物状态、牧草余量、产物待收）
  feeding.ts      // 投喂决策：缺草时补草（种植侧 or 商店买）
  harvest.ts      // 收产物 / 收成熟体 / 出售
  purchase.ts     // 买幼崽（金券预算约束）
  friend-ranch.ts // 好友牧场清理便便
  index.ts        // barrel
```

挂载方式：**独立定时任务**，不挤占 farm tick：

- `workerScheduler.setIntervalTask('ranch_loop', ...)` + `runExclusiveAutomationTask('ranch_tick')`（`services/automation-lock.ts:14-34` 是全进程单链互斥，天然和其他自动化不打架）
- 给 `worker.ts:115` 的 `businessBackoffMs` 加 `ranch` key，网关不回包时独立退避
- 请求班次：自家牧场 → `farm`；好友牧场 → `friend`；面板查询走默认 `foreground`。**别用 `background`**（排队超 8s 直接让路，`utils/network.ts:487-500`）
- 新 notify 必须挂进 `handleNotify`（`network.ts:564+`），否则实时状态收不到

### 4.2 分阶段落地

| 阶段 | 内容 | 主要文件 | 预估代码量 | 前置 |
|---|---|---|---|---|
| **P0** | 协议逆推 + proto 落地 + roundtrip 单测 | `proto/animalpb.proto`（新建）、`utils/proto.ts` 注册 | 200-400 行（含单测） | 抓包或客户端提取 |
| **P1** | 只读面板：牧场状态展示（窝/棚、动物、成长进度、牧草、待收产物） | `services/ranch/api.ts` + `state.ts`、`controllers/admin/ranch-routes.ts`、`web/src/views/Ranch.vue` | 500-800 行 | P0 |
| **P2** | 自家自动化：自动投喂、收产物、收成熟体、卖产物、金券预算内补幼崽 | `feeding.ts`、`harvest.ts`、`purchase.ts`、worker 挂载、`automation.ranch_*` 开关 | 600-900 行 | P1 |
| **P3** | 好友牧场：清理便便、帮喂牧草（复用现有好友遍历骨架） | `friend-ranch.ts`、`friend` 班次调度 | 300-500 行 | P2 |
| **P4**（可选） | 优化层：罐头加速时机、牧场等级规划、金券收支统计 | `analytics.ts` 扩展、面板图表 | 200-400 行 | P3 |

**P0 是硬门槛**，没过之前 P1-P4 全部无法开始。

### 4.3 开关设计（新增一组 automation 键）

按现有约定，新增开关要动 5 处（Explore 核对过行号）：

1. `core/src/types/config.ts:17-47` 加键（如 `ranch_enabled`、`ranch_feed`、`ranch_harvest`、`ranch_sell`、`ranch_buy`、`ranch_friend_clean`）
2. `core/src/models/store/shared-state.ts:50-81` 补默认值（`ALLOWED_AUTOMATION_KEYS` 由 `Object.keys(default)` 自动推导，无需手改）
3. `web/src/components/settings/AutomationSettingsForm.vue` 加一张「牧场」卡片（现有四张卡 :42-331）
4. `web/src/views/Settings.vue:863 / :916` 两处默认对象
5. `core/src/services/account-config.ts` 的 `SAVEABLE_SETTINGS_KEYS`

间隔类配置若需要，再加 `IntervalConfig` + `applyIntervalsToRuntime`（`account-config.ts:178`）。

### 4.4 风控设计（重要，不要按上限拉满）

牧场是**官方新上线玩法 + 涉及金券经济**，风控等级应该比种植更高：

- 所有牧场请求走 `farm`/`friend` 班次，天然受「非前台业务单在途 1」限制（`utils/request-priority.ts:37-60`）——**不要为了提速去改这个常数**。
- 牧场 tick 间隔建议 ≥ 5 分钟（动物成长是小时级，没必要高频；高频只增加暴露面）。
- 好友牧场遍历必须复用现有分片 + 让路门控（`friend-pet-cache` 的每日分片模式），不要一口气扫全好友。
- 金券购买要有硬上限（如单日消费不超过余额的 X%），避免脚本把金券烧在贵动物上。
- 抓到一个 `isGatewayYieldError` 就整轮让路（`automation-lock.ts:76` 的模式）。

### 4.5 与现有系统的耦合点

1. **牧草 × 种植**：牧草「可在农场种植」→ 若 Plant.json 里有牧草，最优策略是**在自己的地里规划一块牧草地**，由 `services/farm/planting.ts` 的候选集加入牧草种子，产物直供牧场。这比商店买草省金券。需要 P0 阶段先确认牧草的种植物品 ID。
2. **便便 × 好友**：复用 `services/friend/` 的遍历与限流骨架，加一个「清理便便」动作，与偷菜共用一轮好友 tick（在途 1，天然串行）。
3. **图鉴 × 藏品**：牧场图鉴已在 `Illustrated.json`，`services/illustrated.ts` 可能直接能展示，无需额外开发（待验证）。
4. **任务 × 牧场**：成长任务里极可能出现「饲养 N 只动物」「收获 N 个鸡蛋」类任务（参考 `docs/planting-task-first.md` 的调研方法）。若要做，复用 `checkAndClaimTasks` 的快照，零额外请求。

## 五、风险清单

| 风险 | 说明 | 应对 |
|---|---|---|
| **协议猜错** | 网关无 cmd id 表，`service.method` 拼错只表现为超时，极难定位 | P0 必须实测，禁止凭命名规律硬写 |
| **body 字节漂移** | 请求体经 WASM 加密，字段存在性影响字节（`docs/tsdk-runtime.md` 逐字节对齐要求） | 每条 message 做 roundtrip 校验，参照 `core/tests/farm-fertilize-proto.test.js` |
| **封号** | 新玩法 + 经济系统，官方监控大概率更严；多账号同 IP 跑牧场收益行为更显眼 | 间隔放大、单账号限流、不做「秒收秒种」式高频 |
| **热点文件冲突** | `worker.ts`(1276 行)、`network.ts`(1224)、`Settings.vue`(2321)、`data-provider.ts`(476)、`shared-state.ts`(657)、`account-config.ts`(530) | 遵守 `docs/local-change-guide.md`：新文件承载逻辑、一行挂载、不改缩进 |
| **牧场拖慢巡田** | 若塞进 `runFarmTick` | 用独立 loop（见 4.1），这是本方案的核心设计约束 |
| **配置版本不同步** | `ItemInfo.json` 有牧场、`Plant.json` 没有 | P0 阶段重跑 `download-game-config.js` 全量对齐 |

## 六、建议的执行顺序

1. **等玩法正式上线**（现在配置下发但协议未出，抓不到真实流量。灰度期抓包也可能拿到半成品协议）。
2. **上线后第一件事**：`tool/download-game-config.js` 全量拉配置 → 对比 `Animal.json` 等新表 → 确认牧草来源与栏舍结构。
3. **同天抓包**按第三章清单跑一轮 → `decode-latest-protocols.js --all --shape` → 确认 service/method/字段。
4. **P0 落地协议 + 单测**，先只做 `GetRanchInfo` 一条，跑通「能读到自己的牧场状态」。
5. 之后按 P1 → P2 → P3 推，每阶段都能独立验证、独立回滚。

**工作量总估**：P0 取决于抓包与逆推顺利程度（2-4 天，含试错）；P1-P3 合计约 1400-2200 行、5-7 个工作日。**不含**牧场上线前的不确定性（官方可能改协议、可能限制第三方调用）。

## 七、我的判断

**值得做，但不要在玩法定档前抢跑。**

理由：这个项目的自动化护城河在于「协议 + 配置 + 面板」三者齐全，牧场的数据侧官方已经白送了（83 条物品配置全在），意味着接入成本主要在协议逆推这一锤子买卖上，一旦通了，P2/P3 的自动化模式可以大量复用现有代码（好友遍历、限流、开关、面板）。

反面：**牧场是经济系统**（金券、买卖、加速道具），这类玩法在官方风控里优先级最高；多账号跑牧场的封号风险高于种菜。建议第一版只做「投喂 + 收货 + 卖产物」这种保守闭环，不做自动买幼崽套利、不做高频轮询。
