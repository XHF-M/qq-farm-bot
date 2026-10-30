# 代码逻辑总览

> 面向要改这个项目源码的人。根目录 [README](../README.md) 讲「怎么用」，本文讲「代码怎么转」。
> 与 `docs/` 下其它专题文档的关系：本文是骨架，`network-concurrency.md`、`config-storage.md`、`tsdk-runtime.md`、`friend-pet-cache.md` 等是单点深挖。

## 0. 阅读顺序建议

| 你想干什么 | 从这里看 |
| --- | --- |
| 快速建立全景印象 | §1 一句话架构 + §2 目录地图 |
| 搞懂「一个账号跑起来都发生了什么」 | §3 进程模型 → §4 启动时序 |
| 加一个游戏玩法 / 改协议请求 | §5 通信层 → §6 业务层 → §12 扩展点 |
| 加一个面板接口 / 页面 | §9 后端路由 → §10 前端 |
| 排查「配置改了为什么没生效」「为什么重复执行」 | §7 并发与互斥 → §8 配置下发 |

---

## 1. 一句话架构

**一个常驻主进程托管 Web 面板，每个游戏账号跑在独立 Worker 里，Worker 通过 WebSocket 直连游戏网关，用 protobuf 收发、用 WASM 做加密，靠一个自续期的统一调度器串行跑「自有农场 + 好友」两条业务主线。**

```
┌─────────────────────────── 浏览器 (Vue3 SPA) ───────────────────────────┐
│  REST /api/*  +  Socket.IO /socket.io  (x-admin-token 鉴权)              │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │ HTTP / WS
┌───────────────────────────────▼─────────────────────────────────────────┐
│ 主进程 client.ts                                                         │
│  ├─ Express (controllers/admin)  ← 鉴权、静态资源、SPA fallback          │
│  ├─ Socket.IO 房间 account:<id>  ← 只推给订阅该账号的连接                │
│  ├─ runtime-engine                                               │
│  │   ├─ runtime-state   全局日志环 / 状态归一化 / 配置 revision          │
│  │   ├─ worker-manager  启停 / IPC 请求-响应 / 掉线清理                  │
│  │   └─ data-provider   面板 API 的统一数据源（把请求转成 worker RPC）    │
│  └─ models/store        store.json / accounts.json / account-configs/**  │
└──────────┬──────────────────────────────────────────┬───────────────────┘
           │ worker_threads postMessage               │ (pkg 打包时退化为 fork)
┌──────────▼──────────────┐              ┌────────────▼──────────────┐
│ Worker (账号 A)          │              │ Worker (账号 B)            │
│ core/worker.ts           │              │  ...                       │
│  ├─ utils/network.ts     │──WebSocket──▶│                            │
│  ├─ services/farm        │  游戏网关     │                            │
│  ├─ services/friend      │              │                            │
│  ├─ services/activity-*  │              │                            │
│  └─ automation-lock      │              │                            │
└─────────────────────────┘              └───────────────────────────┘
```

**三个关键约束决定了大部分代码的写法：**

1. **游戏登录 code 是一次性的** → 掉线/超时后 Worker 不复用旧 code 重连，直接自退，等用户换 code。
2. **游戏网关对并发敏感** → 所有请求走一个分级队列（5 个「班次」），业务之间用进程级大锁串行。
3. **面板是「一个账号一个视图」** → 状态、日志、RPC 全部按 `accountId` 路由，房间化推送。

---

## 2. 目录地图

### 后端 `core/`

| 路径 | 职责 | 关键文件 |
| --- | --- | --- |
| `client.ts` | 进程入口：起面板 + 起 runtime-engine | 30 行左右，很薄 |
| `src/runtime/` | **编排层**：多账号生命周期、IPC、状态汇总 | `runtime-engine.ts`、`worker-manager.ts`、`runtime-state.ts`、`data-provider.ts`、`relogin-reminder.ts` |
| `src/core/worker.ts` | **单账号主程序**：连网关、跑调度器、执行 RPC（1200 行，最核心） | `startBot` / `runStartupSequence` / `startUnifiedScheduler` / `handleApiCall` |
| `src/controllers/admin/` | Express 路由 + Socket.IO + 鉴权中间件 | `index.ts` 挂载顺序，`auth-routes.ts` 全局闸门，`socket.ts` 实时推送 |
| `src/services/` | **业务层**（68 个文件），每个文件一类游戏玩法 | `farm/`、`friend/`、`activity-center/`、`warehouse.ts`、`task.ts` |
| `src/utils/` | **通信层**：WS 连接、protobuf、WASM、并发分级、心跳 | `network.ts`(1224 行)、`proto.ts`、`tsdk-runtime.ts`、`request-priority.ts` |
| `src/models/` | 持久化：管理员凭据、账号、配置 | `admin-store.ts`、`store/*.ts` |
| `src/config/` | 运行时全局配置（单例 CONFIG）、数据目录、游戏静态配置 | `config.ts`、`runtime-paths.ts`、`gameConfig.ts` |
| `src/proto/` | 39 个游戏协议定义 | 见 §5.2 分组 |
| `src/gameConfig/` | 游戏静态表（作物、道具、图鉴、BUFF） | JSON |
| `src/activity-data/` | 活动静态数据 | JSON |

### 前端 `web/`

| 路径 | 职责 |
| --- | --- |
| `src/main.ts` | 装配 Pinia/Router + 三层全局错误兜底 |
| `src/router/index.ts` | 路由表 + token 校验守卫 |
| `src/api/index.ts` | axios 实例、`x-admin-token` / `x-account-id` 注入、401 处理 |
| `src/stores/` | 15 个 Pinia store（服务端镜像 + 本地 UI 状态） |
| `src/views/` | 9 个页面；`Personal.vue` 是 5 个 Tab 的聚合页 |
| `src/components/` | 按域分组：`ui/`、`activity/`、`commerce/`、`settings/` |
| `src/layouts/DefaultLayout.vue` | PC 侧栏 / 移动端底栏的容器 |

---

## 3. 进程模型：主进程 + 每账号一个 Worker

### 3.1 运行时模式（两种，默认线程）

`runtime-engine.ts:33` 读 `FARM_RUNTIME_MODE`，默认 `thread`：

| 模式 | 触发条件 | 实现 | 备注 |
| --- | --- | --- | --- |
| `thread`（默认） | 源码运行 / 常规启动 | `new Worker(worker.ts)`，账号 ID 走 `workerData.accountId` | tsx 下注入 `--require tsx/cjs` 才能加载 TS |
| `worker`（fork） | `pkg` 打包产物，或显式设置 | `fork(mainEntryPath, {env:{FARM_WORKER:'1'}})` | `FARM_WORKER=1` 时入口不再起面板，直接进 worker 分支 |

> README 里说「管理多个 Bot 子进程」是历史说法，当前默认是 **worker_threads 线程**，两种通道在 `worker.ts` 里被封装成同一套 `sendToMaster` / `onMasterMessage`，业务代码不感知。

### 3.2 一账号一 Worker（强绑定）

`workers[accountId]`（`runtime-state.ts`）是唯一注册表。重复启动直接返回 false；`core/worker.ts` 里所有落盘路径都靠 `process.env.FARM_ACCOUNT_ID`（由 manager 注入，线程模式下从 `workerData` 回填）来区分账号——**所以「账号隔离」是靠进程边界 + 环境变量，不靠参数透传。**

### 3.3 IPC 消息表

| 方向 | type | 作用 |
| --- | --- | --- |
| 主 → Worker | `start` | 带 code/platform/系统配置启动连接 |
| | `stop` | 优雅停机（`quiesceBot`） |
| | `api_call` | **面板请求转发**，带 `id/method/args` |
| | `config_sync` | 下发账号配置快照（含 `__revision`） |
| | `reload_config` | 重新加载 gameConfig 静态表 |
| Worker → 主 | `status_sync` | 每 3s 一次的状态快照 |
| | `log` | 日志条目 |
| | `stat_update` | 操作计数 |
| | `error` / `ws_error` | 异常 / 握手被拒（code 400 提示更新 Code） |
| | `account_kicked` / `account_disconnected` | 被踢 / 断线 |
| | `api_response` | `api_call` 的回包（按 reqId 匹配 + 超时表） |
| | `friend_blacklist_add` / `known_friend_gids_sync` / `known_friend_gid_remove` | 数据回写 |
| | `push_notify` | 让主进程走 pushoo 推送 |

### 3.4 Worker RPC：面板能对账号做什么

`worker.ts:782 handleApiCall` 是一个巨型 `switch`，**60 余个方法**，按域可归成：

| 域 | 代表方法 |
| --- | --- |
| 农场 | `getLands`、`doFarmOp`、`fertilizeOwnLand`、`fertilizeAllOwnLands`、`buyFertilizer` |
| 背包/种子 | `getBag`、`getBagSeeds`、`getSeeds`、`purchaseSeed`、`useItem`、`sellItems`、`setItemsLocked` |
| 好友 | `getFriends`、`getFriendLands`、`doFriendOp`、`delFriend`、`getInteractRecords` |
| 图鉴/宠物 | `getIllustratedSnapshot`、`claimIllustratedRewards`、`getPetInfo`、`activateDog`、`deployDog` |
| 活动 | `getActivityDirectorySnapshot`、`getActivityCenterSnapshot`、`getCurrentStellarActivity`、`operatePetDiary`、`buyWeatherBottle` … |
| 商城 | `getDailyGiftOverview`、`getDiamondBalance`、`checkAndBuyFertilizer` |
| 配置 | `setAutomation`、`applyRuntimeConfigSnapshot`（唯一不要求 `loginReady` 的方法） |

这一层是**面板和游戏之间的唯一合法通道**：前端从不知道自己连的是谁，只发 `/api/xxx`，后端 `data-provider` 再转成 `api_call` 打到对应 Worker。

### 3.5 生命周期与异常

| 场景 | 谁负责 | 行为 |
| --- | --- | --- |
| 面板点启动 | `account-routes` → `data-provider` → `startWorker` | 新建 Worker，发 `start` |
| 新增/修改账号 | `account-routes` | 自动启动 / 重启该账号 |
| 手动停止 | `stopWorker` | 发 `stop`，1s 后强杀兜底 |
| 进程异常退出 | `worker-manager` 的 `exit` 监听 | **只清理，不自动重启**（避免用失效 code 反复撞网关） |
| 被踢 / 断线 | Worker 自退 + 上报 | 主进程停 Worker、置错误状态、触发推送 |
| 长期离线 | `relogin-reminder` + `offlineDeleteSec` | 超时推送提醒 → 停 → 删除账号 |

`client.ts` 调 `runtimeEngine.start({ autoStartAccounts: false })`，**所以重启主进程后账号需要手动拉起**——这是有意设计，不是 bug。

---

## 4. 账号启动与调度时序

### 4.1 `startBot` → `runStartupSequence`（登录期串行）

```
startBot(config)                                    worker.ts:541
 ├─ updateRuntimeConfig(时区/网关/版本/设备)         ← 配置在连网关前必须就位
 ├─ loadProto()                                      ← 39 个 .proto 一次性构建 Root
 ├─ applyRuntimeConfig(本地快照)                      ← 种植策略、间隔、开关
 ├─ connect(code) ──▶ WS 握手 ──▶ Login ──▶ online
 │     └─ 登录回执回填 gid/昵称/等级/金币 + 同步服务器时间
 └─ onLoginSuccess
      └─ runStartupSequence()                       worker.ts:386
           ├─ 刷新活动窗口（判开放期）
           ├─ runDailyRoutines()   邮件/分享/月卡/免费礼包/VIP
           ├─ checkAndClaimTasks() 任务领取
           └─ 以上全串行跑完，才挂：
                ├─ startFarmCheckLoop()       [externalScheduler]
                ├─ startFriendCheckLoop()     [externalScheduler]
                ├─ startUnifiedScheduler()    ← 真正驱动上面两条
                ├─ startDailyRoutineTimer()   30s 跨日检测
                └─ startMysteryShopTimer()    2h 神秘商店轮询
```

注释里写得很直白：以前是 2s/8s/45s/60s 四个错峰定时器，结果礼包要等一分钟，还和巡田叠在一起打满连接。现在改成**登录后一口气串行做完再挂主循环**。

### 4.2 统一调度器：一个 setTimeout 驱动两条主线

```
scheduleUnifiedNextTick()                    worker.ts:336
   delay = max(1000, min(nextFarmRunAt, nextFriendRunAt) - now)
   └─ runUnifiedTick()                        worker.ts:323
        ├─ if (dueFarm)   runExclusiveAutomationTask('farm_tick',   runFarmTick)
        └─ if (dueFriend) runExclusiveAutomationTask('friend_tick', runFriendTick)
```

要点：

- **不并行**，农场跑完才跑好友（注释：避免并发请求过多导致超时）。
- 每轮结束后把 `nextXxxRunAt = now + randomIntervalMs(min,max)`，**间隔是区间内随机**，不是固定节拍。
- 没有「任务注册表」，子任务靠在 tick 里读开关再调用：`runFarmTick` 里依次判 `auto.farm` / `auto.task` / `fertilizer_gift`。
- 网关不健康时 `nextBusinessTickDeferMs` 会让整轮退避（心跳漏拍 / 在途请求超 5s）。

### 4.3 安静时段与开关

**调度器不管安静时段，由业务入口自己判断**：

- 自有农场：`checkFarm` → `inFarmQuietHours()`
- 好友：`checkFriends` → `inFriendQuietHours()`

好处是手动操作（`doFarmOp`）不受安静时段影响——安静时段只约束自动化。

---

## 5. 游戏网关通信层

### 5.1 连接与登录

```
code (抓包 / 微信扫码 / QQ扫码)
  └─ wss://gate-obt.nqf.qq.com/prod/ws?platform=&os=&ver=&code=
       + 伪造 UA / Origin
       └─ open → 发 UserService.Login（或 ≥1.15 的 PlayerLogin）
            └─ 回执：gid / nickname / level / gold，同步服务器时间
                 └─ bindUser(openId) + stageInitToken(H())
                      └─ phase=online → 启动 ACE 心跳 + 业务心跳
                           └─ GetUserSettings → PlayerSceneLogin(global_scene_id=1)
                                └─ onLoginSuccess
```

项目**没有**「HTTP 换 token → 发现网关地址」那一步，网关地址来自 `CONFIG.serverUrl` 固定配置。

### 5.2 帧结构与路由

```
GateMessage { meta, body, token }
  meta.message_type = 1 Request / 2 Response / 3 Notify
  meta.service_name + method_name  ← 路由键，proto 里没有数字消息 ID
  body → cryptoWasm.encryptBuffer 就地加密后再整帧编码
```

- `proto.ts` 用 `protobufjs.Root` 一次性显式加载 39 个 `.proto`（目录里另有 `autumn-activities` / `milk-tea` / `pet-diary`，由 `activitypb.proto` import 递归解析），`keepCase: true`。
- 请求/响应靠自增 `client_seq` + `pendingCallbacks: Map<seq, Pending>` 关联。
- Notify 先解 `EventMessage{message_type, body}` 外壳再按类型名分派。
- **单请求默认 20s 超时，无自动重试**（code 一次性，重试没意义）。

`.proto` 分组：网关外壳（`game.proto`）｜登录场景（`userpb`/`player-login`/`globalscenepb`）｜农场（`plantpb`/`corepb`）｜背包推送（`itempb`/`notifypb`）｜社交（`friendpb`/`visitpb`/`interactpb`/`sharepb`/…）｜商业化（`shoppb`/`mallpb`/`mysteryshoppb`/`paypb`）｜活动（`activitypb` + `autumn-activities`/`milk-tea`/`pet-diary`/`weatherpb`/`solartermspb`）｜养成（`taskpb`/`illustratedpb`/`careerpb`/`dogpb`/`mutantpb`）｜安全杂项（`acepb`/`miscpb`）。

### 5.3 加密与 token

- `tsdk.wasm`（QQ）/ `tsdk-wx.wasm`（微信），启动时校验 SHA-256，`TsdkRuntime` 是单例门面（`crypto-wasm.ts` 只是转发）。
- 对外能力：`ba` 加密 / `ca` 解密、`H()` 取一次性凭据、`stageInitToken` 暂存（`next()` 原子消费一次后回退随机 token）、`M/P/E/fa` 心跳与变速检测。
- 每帧 `token` 默认是 64~127 位随机串，只有登录后第一帧用 TSDK 凭据。

### 5.4 并发分级：五个「班次」

这是这个项目最有意思的一块，也是 `docs/network-concurrency.md` 的主角。

| 班次 | 典型来源 | 定位 |
| --- | --- | --- |
| `critical` | 心跳、ACE | 独占槽位，永不排队 |
| `foreground` | 面板手动操作 | 用户点了必须快 |
| `farm` | 巡田、种植、收获 | 业务主线 |
| `friend` | 好友访问 | 主线但可让路 |
| `background` | 好友宠物补齐、图鉴补数据 | 随时可被打断 |

三层协作：

1. `request-priority.ts`：纯策略，决定「下一个该发谁」，排队超 4s 会自动提权防饿死。
2. `request-context.ts`：`AsyncLocalStorage` 让任务内部的所有请求**自动继承班次**，业务代码不用手传。
3. `network.ts`：`sendMsgAsync` 归档 → 查配额 → 入队 → `drainRequestQueue`；`background` 排队超 8s 直接抛 `GatewayBusyError` 让路。
4. `low-priority-gate.ts`：空闲判定 + 30s→60s 退避 + 让路错误分类。
5. `request-pressure.ts`：只做日志节流（5s 一次），不参与调度。

### 5.5 心跳与保活

- 固定 25s 一次，`preventOverlap` 防重入。
- 判死条件是**双条件**：`miss ≥ 3` **且** 入站数据静默 > 30s。只要服务器还在推东西，即使心跳失败也不掉线（`keepalive-policy.ts`）。
- 没有前后台自适应调频。

### 5.6 QQ / 微信双端差异

| 维度 | QQ | 微信 |
| --- | --- | --- |
| WASM | `tsdk.wasm` | `tsdk-wx.wasm` |
| AppID | `1112386029` | `wx5306c5978fdb76e4` |
| debugMode | 0 | 2 |
| 宿主特征 | 额外 64 字节修正后才调 `H()` | 直接调 |
| device_info | 基础字段 | 多带 network / device_id / memory |
| minigame_channel | `other-qq` | `other` |
| 登录方式 | Code / 扫码（依赖外部 qq-miniapp-auth） | Code / 扫码（内部 `wx-login/` 走原生协议） |

---

## 6. 业务自动化层

### 6.1 自有农场：一次「巡田」的完整判定链

`checkFarm()` → `runFarmOperation('all')`（`farm/scheduler.ts:141`），**全串行、顺序固定**：

```
1. getAllLands()                        拿 24 块地
2. analyzeLands(lands, isFirst, gid)     分类：可收/待除草/待除虫/待浇水/枯死/空地/
   （land-analysis.ts）                  可解锁/可升级/生长中；阶段判定靠 grow_phases 倒推
3. farming(landIds, socialEventItemIds)  一键务农：草+虫+水+道具清理+青蛙合并成一次请求
4. harvest(可收地块)                      收获成功后 emit farmHarvested
   └─ 延迟 1~1.5s → resolveRemovableHarvestedLands() 区分「可铲/进下一季/未知」
      未知一律不铲（防误铲）
5. autoPlantEmptyLands(dead, empty)      先 removePlant 铲枯地 → 重新 analyze 确认
   （planting.ts）                         → 按策略选种 → 种植 → 成功地块施肥
6. runMultiSeasonFertilizer(进下一季的地块)
7. unlockLand / upgradeLand（受 land_upgrade 开关）  每块间隔 1~1.5s
8. runFertilizerByConfig([], {skipNormal})  smart 模式的有机肥
   └─ 施肥可能让作物成熟 → harvestMatureOwnLandsOnce() 只追收一次（防请求循环）
```

### 6.2 种植策略分派

7 种策略都在 `planting.ts` 里，入口是 `autoPlantEmptyLands`：

```
bag_priority ──▶ plantFromBagSeeds（按 bagSeedPriority 排序、多格种子装箱、不足预留空地）
                  └─ 背包种不出 / 用尽 ──▶ getBagSeedFallbackStrategy（第二优先策略）
其余 6 种 ──────▶ plantFromShop ──▶ findBestSeed
                                    ├─ max_exp / max_fert_exp / max_profit / max_fert_profit
                                    │    → 映射到 getPlantRankings 的排序键
                                    ├─ preferred → 首选种子提到队首
                                    └─ level     → 默认按 level+id 排序
购买前双重约束：金币余额 + 商店限购额度
```

施肥同样是策略分派：`runFertilizerByConfig` 按 `none / normal / organic / both / smart` 分支。

### 6.3 好友访问

```
checkFriends()                             friend/scheduler.ts
 ├─ getFriends()                          顺带刷新面板缓存
 ├─ 黑名单过滤 → buildFriendVisitPlan()    纯函数：一次算清谁偷/谁帮/谁只捣乱 + 排序
 └─ 逐个 visitFriend()                    visit-strategy.ts
      ├─ 三件事都不用做 → 连 Enter 都不发（省一次请求）
      ├─ enterFriendFarm()                回包顺手写宠物缓存
      ├─ analyzeFriendLands()             含蔬菜黑名单过滤
      ├─ 帮助（批量失败降级逐块，30s 快照去重）
      ├─ 偷菜（批量失败降级单块，偷完可自动卖）
      ├─ 捣乱（受共享额度限制，命中上限落盘，重登后当天不再试）
      └─ leaveFriendFarm()
```

三类闸门各自生效位置不同：

| 闸门 | 生效点 | 效果 |
| --- | --- | --- |
| 黑名单 | `visit-plan.ts` | 计划阶段就排除，零请求 |
| 安静时段 | `scheduler.ts` | 整轮不跑，零请求 |
| 帮助经验上限 | `scheduler.ts` 预筛 + 轮中二次拦截 | 达上限自动关帮助 |

**好友宠物缓存**：唯一数据源是 `enterFriendFarm` 回包，只存 `{dogId, date}`，跨天即失效；`pet-sync.ts` 负责每日补齐（background 班次、批 5 人、位间隔 2s、进人前等网关空闲、配额自适应上限 25）。

### 6.4 活动中心：注册表 + 快照聚合

```
activity-gameplay-registry.ts
  GAMEPLAY_ADAPTERS = [{ gameplayKey, detailTarget, priority, activityIds(ctx) }]
        │
        ├─ buildActivityGameplayBindings()  activityId → [binding...]
        └─ resolveActivityGameplays()       按 priority 取首个作为主玩法，其余进 gameplayTargets

activity-center.ts
  buildActivityDirectory()   遍历活动窗口，按「同名 + 时间重叠」合并成组 → activities[]
  buildActivityCenterSnapshot()  每路 settleRequest 单独兜错（一路失败不影响整体）
  serializeMutation()        所有写操作经 mutationTail 串行
  getActivityCenterSnapshot()  pendingSnapshotRequest 合并并发重复拉取
```

活动开放期由 `activity-windows.ts` 判断（ActivityList 缓存 5 分钟，`activitiesChanged` / `disconnected` 主动失效）。**窗口外的活动仍然展示，只是动作为 disabled**——这是刻意的产品决定。

### 6.5 其余能力一句话

| 模块 | 职责 |
| --- | --- |
| `warehouse.ts` | 背包读取、果实批量出售（受活动售卖条件约束）、开化肥/慈善礼包 |
| `task.ts` | 每日/成长/主线任务扫描与领取（`taskInfoNotify` 1s 去抖） |
| `mall.ts` / `commerce.ts` | 免费礼包、化肥阈值自动购买、商城目录与购买、神秘商店统一入口 |
| `mystery-shop-auto.ts` | 神秘商店到货监控 + 自动购买（2h 轮询） |
| `illustrated.ts` / `analytics.ts` | 图鉴查询与领奖 / 作物效率排行（供种植策略排序） |
| `stats.ts` | 操作计数、金币经验增量，按账号落盘 |
| `pets.ts` / `solar-calendar.ts` / `weather-activity.ts` | 狗与狗粮 / 节气 / 雨落成诗 |
| `push.ts` | pushoo 多通道推送 |
| `wx-login/` / `qq-login/` | 微信原生协议登录 / QQ 小程序登录任务流 |

---

## 7. 并发与互斥

三把锁，作用域不同：

| 机制 | 作用域 | 解决的问题 |
| --- | --- | --- |
| `automation-lock.ts` | **单 Worker 进程一把大锁** | 巡田、好友、宠物补齐、神秘商店之间不并发抢连接 |
| `request-priority` 队列 | 单连接 | 面板手动操作永远插队到自动化前面 |
| `config.__revision` | 主进程 ↔ Worker | 配置快照乱序到达时丢弃旧版本 |

`automation-lock` 的细节值得记一笔：用 `tail` 链 + `AsyncLocalStorage` 打重入标记，**任务体内再调 `runExclusiveAutomationTask` 直接执行、不会自锁**。所以「收获后自动出售」这种嵌套调用是安全的。

被这把锁保护的入口：农场 tick、好友 tick、启动序列、宠物同步、神秘商店、收获后出售。

---

## 8. 配置与持久化

### 8.1 数据目录

| 位置 | 内容 |
| --- | --- |
| `store.json` | 全局：`ui` / `loginSettings` / `offlineReminder` / `systemConfig` / `defaultAccountConfig` |
| `accounts.json` | 账号列表 + `nextId` |
| `account-configs/<id>.json` | 每账号配置（拆分存储，带 `.format.json` 版本标记） |
| `known_friend_gids/<id>.json` | 好友 GID 缓存 |
| `stats/<id>.json` | 当日操作/收益统计 |
| `friend-pet-<hash>.json` | 好友宠物缓存 |
| `logs/combined.log`、`error.log` | winston 日志（code/token/密码自动脱敏） |
| `admin.json` / `login-attempts.json` | 管理员凭据 / 登录限流 |
| `tsdk/<accountId>/` | TSDK WASM 运行时缓存 |

数据目录：源码运行是 `core/data/`，二进制运行是 exe 同级 `data/`（`runtime-paths.ts`）。

### 8.2 配置分层

- **进程级** `CONFIG` 单例：启动时由 `store.getSystemConfig()` 注入一次。
- **账号级**：全部在 `account-configs/`，`AccountConfig` 类型见 `types/config.ts`——`automation`（约 30 个开关）、`plantingStrategy`、`intervals`、`friendQuietHours`、黑名单、`bagSeedPriority` 等。
- **全局级**：`store.json`。

### 8.3 下发机制（改配置为什么能生效）

```
面板保存 → data-provider 写盘 → nextConfigRevision() 生成 __revision
        → broadcastConfigToWorkers 逐个 send(config_sync)
        → Worker applyRuntimeConfig(snapshot, syncNow=true)
             ├─ rev < appliedConfigRevision → 直接丢弃
             ├─ 未登录时才接受网关地址/版本/设备（登录后改这些需要重启）
             └─ 间隔变更 → applyIntervalsToRuntime 重算 nextFarmRunAt/nextFriendRunAt
```

写入一律走 `writeTextFileAtomic`（临时文件 + rename）；`saveGlobal` / `saveAccount` 用 JSON 字符串比对做去重。**没有 debounce**，每次保存即落盘。

---

## 9. Web 后端

### 9.1 挂载顺序（`controllers/admin/index.ts:76-83`）

```
express.json → 手写 CORS → 静态 web/dist + /game-config
  → mountAuthRoutes  ←★ 内部 app.use('/api') 成为全局鉴权闸门
  → wx-login / qq-login / farm / friend / account / activity-center / commerce
  → SPA fallback（/api 与 /game-config 返回 404 JSON，其余回 index.html）
  → listen(0.0.0.0, CONFIG.adminPort || 3007)
  → setupSocketIO
```

**鉴权边界要特别注意**：`auth-routes.ts:67` 里 `app.use('/api', ...)` 只放行 `/login` 和 `/game-version`，其余全部要 `x-admin-token`。因为它在最前面挂载，**后面所有路由模块的 `/api/*` 都被这层覆盖**，包括 `/api/ping`、`/api/auth/validate`。所以"哪些接口不用登录"的答案是：只有 login 和 game-version。

### 9.2 路由总表

| 模块 | 前缀 |
| --- | --- |
| auth | `/api/login`、`/api/logout`、`/api/user/*`、`/api/auth/validate`、`/api/ping`、`/api/scheduler` |
| account | `/api/accounts*`、`/api/account/remark`、`/api/account-logs`、`/api/logs`、`/api/settings/*` |
| farm | `/api/status`、`/api/lands`、`/api/bag*`、`/api/seeds*`、`/api/pets*`、`/api/farm/*`、`/api/analytics`、`/api/config/*` |
| friend | `/api/friends*`、`/api/friend/*`、`/api/interact-records`、`/api/friend-blacklist`、`/api/friend-known-gids*` |
| activity-center | `/api/activity-center/*`（activities / stellar / qixi / qingmei / charity / weather / pet-diary） |
| commerce | `/api/solar-calendar`、`/api/illustrated/claim`、`/api/activities/*`、`/api/game-mall`、`/api/mystery-shop` |
| wx-login / qq-login | `/api/wx-login/*`、`/api/qq-login/*`（自己再挂一层 authRequired） |

### 9.3 实时链路（日志与状态）

```
Worker syncStatus()（3s，JSON hash 去重 + 8s 兜底）
  → IPC status_sync
    → worker-manager: normalizeStatusForPanel + 顺手写昵称/头像
      → runtimeEvents.emit('status')
        → client.ts onStatusSync
          → emitRealtimeStatus → io.to(`account:${id}`).emit('status:update')
```

⚠️ `emitRealtimeStatus` / `emitRealtimeLog`（`socket.ts:97-128`）**必须先有 accountId**，否则整条丢弃；而推送只发往 `account:<id>` 房间。因此订阅 `account:all` 的连接**收不到任何实时增量**，只能拿到订阅瞬间的 `logs:snapshot` 快照。

### 9.4 管理员鉴权

- 默认 `admin/admin`，模块加载即创建，`mustChangePassword: true`。
- 口令 PBKDF2-SHA512 10 万次（旧 sha256 自动重算）。
- Token 是 `randomBytes(24).hex`，**只存在内存**，重启全失效。
- 限流：IP 60s 内 10 次；密码错 5 次锁 15 分钟；落盘 `login-attempts.json`。
- 改密成功会 `ctx.tokens.clear()`，所有在线会话立即掉线。

---

## 10. Web 前端

### 10.1 启动与守卫

```
index.html 内联脚本读 theme_mode 打 dark 类（防闪白）
  → main.ts: Pinia → Router → 三层错误兜底 → mount
    → router.beforeEach
        ├─ 无 token 且非 /login → 跳 login
        ├─ 有 token：ensureTokenValid() 打 /api/auth/validate（6s 超时，同 token 只验一次）
        └─ 失败清 token 回登录页
```

### 10.2 API 层

- `baseURL: '/'`：生产由 core 同源托管；开发用 Vite 代理 `/api`、`/socket.io`、`/game-config` → `localhost:3007`。
- 请求头自动注入 `x-admin-token`（localStorage `admin_token`）+ `x-account-id`（`current_account_id`），单请求可覆盖账号。
- 响应拦截：HTTP 200 但 `ok:false` 也当错误；401 清 token 硬跳 `/login`；500 里的「账号未运行 / API Timeout」静默交给页面自己处理。

### 10.3 状态管理边界

| 类型 | store | 说明 |
| --- | --- | --- |
| 服务端镜像 | `account` / `farm` / `bag` / `friend` / `setting` / `status` / `commerce` / `illustrated` / `pet` / `pet-diary` / `activity-center` / `plant-blacklist` | 自己发请求、自己写 state |
| 纯本地 UI | `app`（侧栏/主题）、`toast`（去重 + 防抖） | 不碰网络 |
| 混合 | `user`（token 持久化 + 登录动作） | |

`farm` store 有个值得学的细节：**overlay TTL**——本地操作后的乐观结果在 TTL 内不被服务端旧快照覆盖。

Socket.IO 的**唯一初始化点在 `status.ts`**：`io('/', {auth:{token}})` → `emit('subscribe', {accountId})` → 自己处理 `status:update` / `log:new` / `logs:snapshot` 写入 store，组件不参与。触发方是 `Sidebar.vue`（挂载连接、30s ping 探活、断线 10s 轮询兜底）。

### 10.4 页面 ↔ 接口

| 路由 | 视图 | 主要接口 |
| --- | --- | --- |
| `/` | Dashboard | `/api/status`、`/api/logs`、`/api/daily-gifts`、`/api/bag` |
| `/personal` | Personal（农场/图鉴/宠物/背包/任务 5 Tab） | `/api/lands`、`/api/farm/operate`、`/api/illustrated`、`/api/pets*` |
| `/activity` | ActivityCenter | `/api/activity-center/*`、`/api/activities/*` |
| `/friends` | Friends | `/api/friends*`、`/api/friend/:gid/*`、`/api/friend-blacklist` |
| `/analytics` | Analytics | `/api/analytics`、`/api/config/seeds` |
| `/solar-calendar` | SolarCalendar | `/api/solar-calendar` |
| `/game-mall` | GameMall | `/api/game-mall`、`/api/mystery-shop` |
| `/settings` | Settings | `/api/settings/*`、`/api/accounts` |
| `/login` | Login | `/api/login`、`/api/game-version` |

### 10.5 响应式

断点统一 **1024px**：桌面固定侧栏（可折叠）；<1024 侧栏变抽屉 + 遮罩，底部导航只留 5 项（概览/个人/活动/商城/设置）。`fullBleed` 路由隐藏页头与底栏。

### 10.6 构建

| 命令 | 差异 |
| --- | --- |
| `build` | 常规产物 |
| `build:compressed` | 额外产出 `.gz`（>10KB 的资源），给 Nginx 直出 |
| `build:analyze` | 出包体分析报告，同时才开 `reportCompressedSize` |

分包：`vendor-vue` / `vendor-ui`（naive-ui 全家桶）/ `vendor-axios` / `vendor`。

---

## 11. 三条典型调用链串讲

### A. 面板点「一键务农」

```
Personal.vue → farm store.operate()
 → POST /api/farm/operate  (x-admin-token, x-account-id)
   → farm-routes → data-provider.farmOperate()
     → callWorkerApi(id, 'doFarmOp')  ──IPC api_call──▶ Worker
       → handleApiCall → runFarmOperation('all')
         → [§6.1 完整链路]
         ← api_response { actions, hadWork }
   ← res.json({ ok: true, data })
 → store 用回包 + 后续 /api/status 刷新土地
```

### B. 自动巡田（无人工干预）

```
runUnifiedTick (now ≥ nextFarmRunAt)
 → runExclusiveAutomationTask('farm_tick')
   → runWithRequestClass('farm')     所有内部请求自动打上 farm 班次
     → checkFarm → runFarmOperation('all')
       → network.sendMsgAsync（排队 → 心跳槽位永远优先）
 → nextFarmRunAt = now + random(min, max)
```

### C. 改一个自动化开关

```
Settings.vue → POST /api/settings/save
 → account-routes → store 写盘 → nextConfigRevision()
 → broadcastConfigToWorkers(config_sync)
   → Worker applyRuntimeConfig 丢旧版本、应用新开关
     → 若间隔变了：applyIntervalsToRuntime 重算 nextFarmRunAt
     → 若施肥模式变了：600ms 后立即补一次有机肥
   → 面板等 Worker ACK revision 才认为保存完成
```

---

## 12. 扩展点：新增功能改哪里

| 需求 | 改动位置 | 注意 |
| --- | --- | --- |
| 新增一个游戏协议调用 | `proto/` 加定义（或复用已有）→ `services/xxx.ts` 写业务 → `worker.ts handleApiCall` 加 case → `data-provider.ts` 加转发 → `controllers/admin/*-routes.ts` 加路由 → 前端 `api/index.ts` + store | 业务请求记得跑在正确的 `requestClass` 里 |
| 新增一个自动化开关 | `types/config.ts` 的 `AutomationConfig` → 前端 `AutomationSettingsForm` → Worker 入口用 `isAutomationOn('xxx')` | 开关判断放在**业务入口**，不要塞调度器 |
| 新增一个活动玩法 | `activity-center/` 新建 service（工厂函数注入依赖）→ `activity-gameplay-registry.ts` 注册 `{gameplayKey, activityIds, priority}` → `proto/` 补协议 → 前端 `components/activity/gameplays/` | 写操作必须过 `serializeMutation` |
| 新增一个面板页面 | `views/` 建页面 → `router/index.ts` 加路由 → 需要的话加 store → 移动端记得加进 `MobileBottomNav` | 布局断点 1024px |
| 新增一类持久化 | `models/store/` 加模块，用 `json-db.ts` 的原子写 | 别直接 `fs.writeFile` |
| 新增推送事件 | Worker `sendToMaster({type:'push_notify'})` → `services/push.ts` 通道 | 实例级，不区分账号 |

---

## 13. 已知偏差与技术债（读代码时别被坑）

| 现象 | 实情 | 影响 |
| --- | --- | --- |
| README 说「多个 Bot 子进程」 | 默认是 worker_threads 线程；只有 pkg 打包才 fork | 排查进程问题时看 `FARM_RUNTIME_MODE` |
| `src/types/ipc.ts`、`src/types/worker.ts` | **无任何引用**，字段和真实 IPC 消息对不上 | 别拿它当协议文档 |
| `services/rate-limiter.ts` | **零引用**（`sendWithRetry` 没人调） | 真实限流在 `utils/network.ts` 的班次队列 |
| 订阅 `account:all` 的 Socket 连接 | 收不到实时 `status:update` / `log:new`，只有快照 | 多账号"全局日志"功能实际是断的 |
| 前端未监听 `account-log:new` | 只用 REST `/api/account-logs` 拉取 | 账号动作日志不实时 |
| 主进程重启后账号不自动跑 | `autoStartAccounts: false` 是刻意的 | 重启后需手动点启动 |
| 登录后改网关地址/版本/设备 | `applyRuntimeConfig` 只接受未登录时的这几个字段 | 改了要重启账号 |
| 掉线不重连 | code 一次性，Worker 自退 | 想持续挂机必须保证 code 新鲜（QQ 可用 QQFarmCodeHelper 自动同步） |

---

## 14. 相关文档

- [网络并发模型](network-concurrency.md) — 班次分层、排队上限、让路门控的完整细节
- [配置存储、迁移与缓存](config-storage.md) — 拆分存储与迁移备份
- [TSDK Node.js 运行约定](tsdk-runtime.md) — WASM 宿主映射与 ACE 生命周期
- [好友宠物缓存与每日同步](friend-pet-cache.md) — 护主犬三态缓存与分片同步
- [工具脚本](tools.md) — 协议抓包解码、配置下载
