/**
 * 活动作物 / 活动道具补录表。
 *
 * ⚠️ 现状（2026-11-27 起）：官方 `ItemInfo.json` 已包含 20307 / 40307 / 1040307，
 * 官方 `EventPlants.json` 已包含 1020307 红薯，所以本表的名称与作物结构基本走不到了。
 * 保留它只作两道兜底：
 *   1. 手机缓存 / 上游配置更新滞后、EventPlants 缺失该作物时
 *   2. 还没进 EventPlants 的下一期活动作物，先临时补名称和映射
 *
 * 新增活动作物时优先走 EventPlants.json；只有在确定官方配置拿不到时才加到这里。
 *
 * 原始背景：活动临时作物（例如「以薯换福」的红薯 1020307 / 种子 20307 / 果实 40307 /
 * 超变果实 1040307）不在官方静态配置 Plant.json / ItemInfo.json 里，因此：
 *   - 名称会退化成「植物1020307」「物品40307」
 *   - 端口展示拿不到 seed_id，`seedImage` 为空，卡片只剩占位小芽
 *   - 背包拿不到贴图，卡片只剩「物」占位字
 *
 * 这里只补「展示层需要的东西」：作物名称 / 种子 ID / 果实 ID / 贴图地址，
 * 以及物品侧的名称、类型（5 种子 / 6 果实 / 17 超变果实）与贴图。
 * 刻意不写进 Plant.json / ItemInfo.json，因为 getPlantById() 有配置就意味着
 * getAllSeeds() 会把活动种子当成普通作物暴露给种植策略，可能被自动种植消耗掉。
 *
 * 贴图放在 gameConfig/seed_images_named/seed_images/ 下，命名沿用官方的
 * `{ID}.png` 规则，同一张图可以落多个文件名（作物 / 种子 / 果实各一份）。
 *
 * 拿到包含活动作物的官方配置后，整个文件可以直接删掉。
 */

export interface ActivityCropOverride {
    /** 作物 ID（服务端 LandInfo.plant.id） */
    plantId: number;
    /** 种子道具 ID */
    seedId: number;
    /** 果实道具 ID（收获物） */
    fruitId: number;
    /** 展示名 */
    name: string;
    /** 贴图地址（后端静态资源路径） */
    image: string;
    /** 变异（黄金）版作物 ID，仅用于展示层名称映射 */
    goldenPlantId?: number;
    /** 变异（黄金）版果实道具 ID */
    goldenItemId?: number;
    /** 变异（黄金）版展示名 */
    goldenName?: string;
    /** 占地格数，缺省 1；自动种植用它算地块布局 */
    size?: number;
    /** 种植所需土地等级，缺省 0；服务端仍会再校验一次 */
    landLevelNeed?: number;
}

/**
 * 活动道具补录。type 语义与 ItemInfo.type 一致：
 * 5 种子、6 果实、17 超变果实，其余按普通道具处理。
 */
export interface ActivityItemOverride {
    id: number;
    type: number;
    name: string;
    image: string;
}

const IMAGE_BASE = '/game-config/seed_images_named/seed_images';

const ACTIVITY_CROP_LIST: ActivityCropOverride[] = [
    {
        plantId: 1020307,
        seedId: 20307,
        fruitId: 40307,
        name: '红薯',
        image: `${IMAGE_BASE}/1020307.png`,
        goldenPlantId: 1120307,
        goldenItemId: 1040307,
        goldenName: '黄金·红薯',
        size: 1,
        landLevelNeed: 0,
    },
];

const ACTIVITY_ITEM_LIST: ActivityItemOverride[] = [
    { id: 20307, type: 5, name: '红薯种子', image: `${IMAGE_BASE}/20307.png` },
    { id: 40307, type: 6, name: '红薯', image: `${IMAGE_BASE}/40307.png` },
    { id: 1040307, type: 17, name: '黄金·红薯', image: `${IMAGE_BASE}/1040307.png` },
];

const byPlantId = new Map<number, ActivityCropOverride>();
const bySeedId = new Map<number, ActivityCropOverride>();
const byFruitId = new Map<number, ActivityCropOverride>();
for (const crop of ACTIVITY_CROP_LIST) {
    byPlantId.set(crop.plantId, crop);
    bySeedId.set(crop.seedId, crop);
    if (crop.fruitId) byFruitId.set(crop.fruitId, crop);
    // 黄金版作物 ID 也登记一份，服务端直接下发 1120307 时名字才不会退化。
    const goldenPlantId = Number(crop.goldenPlantId) || 0;
    if (goldenPlantId > 0) {
        byPlantId.set(goldenPlantId, {
            ...crop,
            plantId: goldenPlantId,
            name: crop.goldenName || crop.name,
            image: crop.goldenItemId ? `${IMAGE_BASE}/${crop.goldenItemId}.png` : crop.image,
        });
    }
}

const byItemId = new Map<number, ActivityItemOverride>(
    ACTIVITY_ITEM_LIST.map(item => [item.id, item])
);

export function getActivityCropByPlantId(plantId: number | string): ActivityCropOverride | undefined {
    const id = Number(plantId) || 0;
    return id > 0 ? byPlantId.get(id) : undefined;
}

export function getActivityCropBySeedId(seedId: number | string): ActivityCropOverride | undefined {
    const id = Number(seedId) || 0;
    return id > 0 ? bySeedId.get(id) : undefined;
}

export function getActivityCropByFruitId(fruitId: number | string): ActivityCropOverride | undefined {
    const id = Number(fruitId) || 0;
    return id > 0 ? byFruitId.get(id) : undefined;
}

export function getActivityCropName(plantId: number | string): string {
    return getActivityCropByPlantId(plantId)?.name || '';
}

export function getActivityCropImage(plantId: number | string): string {
    return getActivityCropByPlantId(plantId)?.image || '';
}

export function getActivityItemById(itemId: number | string): ActivityItemOverride | undefined {
    const id = Number(itemId) || 0;
    return id > 0 ? byItemId.get(id) : undefined;
}

export function getActivityItemName(itemId: number | string): string {
    return getActivityItemById(itemId)?.name || '';
}

export function getActivityItemImage(itemId: number | string): string {
    return getActivityItemById(itemId)?.image || '';
}

export function getActivityItems(): ActivityItemOverride[] {
    return ACTIVITY_ITEM_LIST.map(item => ({ ...item }));
}

/** 活动作物列表（不含黄金版的派生条目），用于构建合成 Plant。 */
export function getActivityCrops(): ActivityCropOverride[] {
    return ACTIVITY_CROP_LIST.map(crop => ({ ...crop }));
}

/**
 * 是否是活动作物的种子。
 * 自动种植用它把活动种子排在普通种子前面（活动有期限，不种就浪费），
 * 但不会因此进入 getAllSeeds()。
 */
export function isActivitySeed(seedId: number | string): boolean {
    const id = Number(seedId) || 0;
    return id > 0 && bySeedId.has(id);
}
