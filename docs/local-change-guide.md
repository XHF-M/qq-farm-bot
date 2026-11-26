# 本地改动与上游同步指南

在 fork 上改代码，最大的成本不是写功能，而是**上游更新时的冲突**。
这份文档给出这个仓库的「低冲突改动法」：改哪里、怎么改、冲突了怎么办。

> 同步命令本身见 [fork-sync.md](fork-sync.md)，本文只讲**怎么写代码才能少冲突**。

---

## 核心原则

**宁可多写一个新文件，也不要改一行热点代码。**

冲突只发生在「你改的行」和「上游改的行」重叠时。所以减少冲突的本质是：
把改动尽量放在**上游几乎不会碰的位置**——新文件、列表末尾、单行挂载点。

判断一个改动值不值得做，先算：

```
收益 ÷ 冲突成本
```

加一行挂载的冲突成本几乎为零；改 `worker.ts` 里 60 个 case 的 switch 内部，成本很高。

---

## 一、按冲突风险给改动分层

| 层级 | 做法 | 典型冲突面 | 建议 |
|---|---|---|---|
| **L0** | 只改配置（面板设置、`.env`） | 0 | 能用就用 |
| **L1** | 新增文件 + 单行挂载 | 1~2 行 | **主力手段** |
| **L2** | 在模块内加小函数，原函数体末尾加一行调用 | 3~5 行 | 谨慎 |
| **L3** | 改热点文件内部逻辑、改判断条件 | 十几~几十行 | 尽量避开 |
| **L4** | 改 `proto` / 加密 / 握手 / WASM | 全文件重写 | **不做** |

先问自己：能不能停在 L0？这个项目自动化开关极多（种植策略 7 种、各类 `auto.*` 开关、间隔、安静时段），
很多「想要的行为」其实只差一个配置项。

---

## 二、这个仓库的挂载点地图

### 低冲突（推荐）

| 想做的事 | 改哪里 | 冲突面 |
|---|---|---|
| 新增一个业务能力（工具函数、统计、上报） | 新建 `core/src/local/xxx.ts`，不接入任何人 | **零** |
| 新增一个前端页面 | 新建 `web/src/views/MyPage.vue` + `web/src/router/menu.ts` 数组加一项 | 1 个数组项 |
| 新增一个前端状态模块 | 新建 `web/src/stores/my-store.ts` | **零** |
| 新增一组 HTTP 接口 | 新建 `core/src/controllers/admin/my-routes.ts`，在 `controllers/admin/index.ts` 第 76~83 行的 `mount*` 列表加一行 | 1 行 |
| 新增一种活动玩法 | `core/src/services/activity-gameplay-registry.ts:29` 的 `GAMEPLAY_ADAPTERS` 数组加一项 + 新建 adapter 文件 | 1 个数组项 |
| 新增一个配置项 | `core/src/types/config.ts` 对应接口**末尾**加可选字段 | 1~3 行 |
| 新增一个定时子任务 | `core/src/core/worker.ts:263` 的 `runFarmTick` 里加一行 `if (auto.xxx) await ...` | **1 行** |

`runFarmTick` 是最舒服的挂载点，原样长这样：

```ts
await runWithRequestClass('farm', async () => {
    if (auto.farm) await checkFarm();
    if (auto.task) await checkAndClaimTasks();
    if (auto.email !== false) await openCharitySettlementGiftPacksSilently();
    if (auto.fertilizer_gift) await openFertilizerGiftPacksSilently();
});
```

加一行就多一个后台任务，天然串行、天然受 `farm` 班次的限流与间隔保护。

### 热点黑名单（改之前先想别的办法）

| 文件 | 行数 | 为什么危险 |
|---|---|---|
| `core/src/core/worker.ts` | 1238 | `handleApiCall` 的 60+ 个 `case` 是上游加接口的必经之地 |
| `core/src/utils/network.ts` | 1224 | 连接/重试/心跳，上游一改就是大改 |
| `core/src/services/friend/visit-strategy.ts` | 961 | 好友策略，上游频繁调 |
| `core/src/services/farm/scheduler.ts` | 559 | 农场核心判定链，上游频繁调 |
| `core/src/types/config.ts` | 150 | 小文件但新增字段必动它 |
| `web/src/router/menu.ts` | 69 | 小文件但加页面必动它 |
| `core/src/config/gameConfig.ts` | — | 跟随游戏版本更新 |
| `core/src/proto/*.proto` | — | **禁止改动** |

`worker.ts` 的 `switch` 有个技巧：把 case 体压成一行调用自己的函数，冲突时只需重贴 1~2 行。

```ts
case 'myGetFoo':
    result = await require('../local/my-feature').getFoo(args[0]);
    break;
```

---

## 三、写代码时的六条硬规则

**1. 新增，不修改**
要改行为，用「包裹」而不是「替换」。原逻辑整块保留，自己加在外围：

```ts
// ❌ 改条件（上游一行改动就冲突）
if (lands.length > 0 && myCondition) { ... }

// ✅ 外挂（原样不动）
await originalLogic(lands);
if (myCondition) await myExtraLogic(lands);
```

**2. 挂载点上下留空行**
Git 按行上下文匹配。贴着别人的代码加行，上游改那行时你必然一起冲突；
中间空一行，冲突范围会被切小，`merge --no-ff` 时更容易自动合。

**3. 绝不跑全文件格式化**
不改缩进、不重排 `import`、不换引号、不删尾随空格。
这是最隐蔽的冲突源：编辑器一保存，整个文件都变成「你改的」，上游任何改动都会撞。
提交前用 `git diff --stat` 检查——如果改动行数是文件总行数的量级，说明格式化误伤了。

**4. 配置项用可选 + 兜底默认**
```ts
// ✅ 不破坏上游旧数据，老配置文件也能读
if (auto.myFeature !== false) { ... }
```
不要改 schema 必填、不要改现有字段类型、不要改字段名。

**5. 本地代码集中放**
新功能一律放 `core/src/local/`（前端放 `web/src/local/`），用你自己的语义命名。
好处：`git diff --stat origin/master..HEAD` 一眼看出「我的改动 = N 个新文件 + M 行挂载」，
哪天要重放补丁，照着文件清单搬就行。

**6. 一个功能一个 commit**
message 写清「为什么 + 接在哪」，不要把所有改动压成一个巨型提交。
提交原子化才能在冲突时单独 `revert`、`cherry-pick`，也才能在 `git range-diff` 里核对补丁是否完整。

---

## 四、完整示例：新增一个「每日收益推送」

**第一步：写新文件，不碰任何现有代码**

`core/src/local/daily-report.ts`
```ts
export {};

let lastRunDay = '';

function shanghaiNow(): { day: string; hour: number } {
    const now = new Date();
    const day = now.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }); // YYYY-MM-DD
    const hour = Number(now.toLocaleString('en-US', {
        hour: '2-digit', hour12: false, timeZone: 'Asia/Shanghai',
    }));
    return { day, hour };
}

/** 每天 08:00 之后首次执行一次，失败不影响主流程。 */
async function tick(): Promise<void> {
    const { day, hour } = shanghaiNow();
    if (hour < 8 || lastRunDay === day) return;
    lastRunDay = day;
    try {
        // 举例：读你要的数据源。具体导出名以 core/src/services/stats.ts 为准。
        const stats = require('../services/stats');
        // ... 组装数据并推送到你自己的 webhook
        void stats;
    } catch {
        // 本地功能永远不向上抛异常
    }
}

module.exports = { tick };
```

**第二步：在 `runFarmTick` 加一行**

```diff
     if (auto.fertilizer_gift) await openFertilizerGiftPacksSilently();
+    await require('../local/daily-report').tick();
 });
```

**第三步：配置项（可选）**

`core/src/types/config.ts` 的 `AutomationConfig` 接口末尾加：
```ts
myDailyReport?: boolean;
```

**最终 diff 规模：1 个新文件 + 1 行挂载 + 1 行可选字段。**
上游再怎么重构农场调度，最坏情况也只是那 1 行要重贴。

---

## 五、Git 层面的准备

### remote 布局（当前已是这个状态）

```bash
git remote -v
# origin  -> liyangpengs/qq-farm-bot   （上游，只 fetch）
# fork    -> XHF-M/qq-farm-bot         （自己的，只 push）
```

### 开启 rerere（强烈建议，一次性）

```bash
git config --global rerere.enabled true
git config --global rerere.autoUpdate true
```

作用：第一次手工解过的冲突，Git 会记住解法。上游下次再改同一处，**自动套用上次的解法**。
对「长期在一个活跃仓库上打补丁」这个场景，收益极高。

### 分支模型

单人自用，推荐 `master` 保持「上游 + 自有提交」，每个新功能开短分支：

```bash
# 开新功能
git switch -c feat/my-thing
# ... 开发、提交 ...
git switch master
git merge --no-ff feat/my-thing      # 保留分支痕迹，方便整体 revert
git push fork master
```

为什么用 `--no-ff`：合并成一个 merge commit，功能出问题时 `git revert -m 1 <merge>` 一刀切掉，
不用逐个挑提交。同步上游时，冲突也会集中在 merge 那一刻。

### 定期体检

```bash
git fetch origin
git log --oneline origin/master..HEAD        # 我有几个自有提交
git diff --stat origin/master..HEAD          # 我改了哪些文件、多少行
git rev-list --count HEAD..origin/master     # 上游领先我多少
```

`git diff --stat` 的输出是健康指标：**新增文件占比越高越健康**。如果全是修改大文件，说明该重构改法了。

---

## 六、同步节奏

**别拖。** 一次合并 30 个上游提交，冲突是灾难；一次合并 3 个，冲突只是小磕碰。

- 上游活跃期（这个仓库提交很密）：至少每周一次
- 上游发版 / 你想用某个新功能时：立刻同步
- 合并前工作区必须干净（`git status` 无输出），否则 `stash` 一下

```bash
git fetch origin
git merge origin/master        # 有冲突先解，别急着 push
git push fork master
```

配置了 `.gitattributes`（仓库已有 `* text=auto eol=lf`），行尾不会造成假冲突，这点不用操心。

---

## 七、冲突了怎么办

**决策树，从上往下走：**

1. **冲突文件是你新增的？**
   → 理论上不该冲突。若上游恰好新增了同名文件，把自己的改名加前缀（`local-xxx.ts`）。

2. **冲突点是 1~2 行挂载？**（最常见）
   → 直接取上游版本，然后把自己的那行重新加上。
   ```bash
   git checkout --theirs path/to/file   # 取上游版本
   # 手工重新插入你的 1 行
   ```

3. **冲突在你改过的上游函数体内？**
   → 优先保上游：`git checkout --theirs`，然后把自己的逻辑抽成独立函数，用「外挂」方式重新接一行。
   这一步等于把 L3 降级成 L1，长期看是净收益。

4. **整个文件被上游重写了？**
   → 放弃在这个文件里改。看上游新代码里有没有新的挂载点（新的列表、新的注册表、新的 hook），
   把自己的逻辑搬过去。这个仓库的注册表式设计（活动注册表、`mount*` 列表）就是为此存在的。

5. **解不开，或者冲突量大到崩溃？**
   → `git merge --abort`，改用 rebase 逐个提交处理：
   ```bash
   git switch -c tmp/rebase-try
   git rebase origin/master       # 一个一个提交过，冲突范围小得多
   ```
   再不行就把那个功能 `git revert` 掉，等上游稳定后照本文重放一遍。

**总原则：永远优先保上游。** 上游是持续演进的活代码，你的补丁是一次性的。
补丁丢了不可怕——只要它小、独立、有文档，就能半小时重放回来。

---

## 八、绝对不要做的事

| 禁止 | 后果 |
|---|---|
| `git reset --hard origin/master` 同步 | 自有提交直接消失，且无 reflog 之外的痕迹 |
| 改 `core/src/proto/*.proto` | 上游一更新全废；协议层改动还可能触发风控 |
| 在 `network.ts` / `tsdk-runtime.ts` / `crypto-wasm.ts` 里加业务逻辑 | 这层上游改动幅度最大，且出错表现为「连不上」，极难排查 |
| 提交 `core/data/`、真实域名、密码 | 仓库公开，等于把入口递出去（`.gitignore` 已挡，别强行 `-f`） |
| 全文件格式化后提交 | 你的每个文件都变成「已修改」，冲突率从 0 变 100% |
| 把 `admin/admin` 改成别的默认值再提交 | 上游有 `mustChangePassword` 机制，硬改反而破坏流程 |

---

## 九、改动台账

在 `docs/local-changes.md` 维护一张表，每条本地改动一行：

| 功能 | commit | 涉及文件 | 挂载点 | 上游重构后如何重放 |
|---|---|---|---|---|
| 部署脚本 | `e6d722f` | `deploy/*`（全新增） | 无 | 直接可用 |
| 代码架构文档 | `656b7ed` | `docs/code-architecture.md`（全新增） | 无 | 直接可用 |

这张表是**补丁丢失后的重建图纸**。加新功能时顺手加一行，成本 10 秒；
真需要重放时能省掉半天。

---

## 一句话总结

**新文件承载逻辑，一行挂载接入，配置项做开关，commit 保持原子。**
做到这四条，上游随便怎么改，你最多只需要重贴几行。
