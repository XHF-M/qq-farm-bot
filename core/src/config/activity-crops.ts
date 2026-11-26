/**
 * 活动作物补录表。
 *
 * 活动临时作物（例如「以薯换福」的红薯 1020307 / 种子 20307）不在官方静态配置
 * Plant.json / ItemInfo.json 里，因此：
 *   - 名称会退化成「植物1020307」
 *   - 端口展示拿不到 seed_id，`seedImage` 为空，卡片只剩占位小芽
 *
 * 这里只补「展示层需要的三件事」：名称、种子 ID、贴图地址。
 * 刻意不写进 Plant.json / ItemInfo.json，因为 getPlantById() 有配置就意味着
 * getAllSeeds() 会把活动种子当成普通作物暴露给种植策略，可能被自动种植消耗掉。
 *
 * 贴图放在 gameConfig/seed_images_named/seed_images/ 下，命名沿用官方的
 * `{作物ID}.png` 与 `{种子ID}.png` 双份规则（同一张图落两个文件名）。
 *
 * 拿到包含活动作物的官方配置后，整个文件可以直接删掉。
 */

export interface ActivityCropOverride {
    /** 作物 ID（服务端 LandInfo.plant.id） */
    plantId: number;
    /** 种子道具 ID */
    seedId: number;
    /** 展示名 */
    name: string;
    /** 贴图地址（后端静态资源路径） */
    image: string;
}

const ACTIVITY_CROP_LIST: ActivityCropOverride[] = [
    {
        plantId: 1020307,
        seedId: 20307,
        name: '红薯',
        image: '/game-config/seed_images_named/seed_images/1020307.png',
    },
];

const byPlantId = new Map<number, ActivityCropOverride>();
const bySeedId = new Map<number, ActivityCropOverride>();
for (const crop of ACTIVITY_CROP_LIST) {
    byPlantId.set(crop.plantId, crop);
    bySeedId.set(crop.seedId, crop);
}

export function getActivityCropByPlantId(plantId: number | string): ActivityCropOverride | undefined {
    const id = Number(plantId) || 0;
    return id > 0 ? byPlantId.get(id) : undefined;
}

export function getActivityCropBySeedId(seedId: number | string): ActivityCropOverride | undefined {
    const id = Number(seedId) || 0;
    return id > 0 ? bySeedId.get(id) : undefined;
}

export function getActivityCropName(plantId: number | string): string {
    return getActivityCropByPlantId(plantId)?.name || '';
}

export function getActivityCropImage(plantId: number | string): string {
    return getActivityCropByPlantId(plantId)?.image || '';
}
