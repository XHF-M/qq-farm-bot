const test = require('node:test');
const assert = require('node:assert/strict');
const { buildLandDetail } = require('../dist/services/farm/land-analysis');
const { getActivityCropByPlantId, getActivityCropBySeedId, getActivityCropName, getActivityCropImage } = require('../dist/config/activity-crops');
const {
    getItemById,
    getItemImageById,
    getFruitName,
    getPlantName,
    getPlantNameBySeedId,
    getMutantDisplayPlantId,
    getAllSeeds,
} = require('../dist/config/gameConfig');

test('activity crop override maps 红薯 by plant id and seed id', () => {
    assert.equal(getActivityCropName(1020307), '红薯');
    assert.equal(getActivityCropImage(1020307), '/game-config/seed_images_named/seed_images/1020307.png');
    assert.equal(getActivityCropByPlantId(1020307).seedId, 20307);
    assert.equal(getActivityCropBySeedId(20307).name, '红薯');
    assert.equal(getActivityCropByPlantId(0), undefined);
    assert.equal(getActivityCropByPlantId(20307), undefined);
});

test('land detail falls back to the activity crop name and image', () => {
    const land = {
        id: 1,
        unlocked: true,
        level: 1,
        max_level: 5,
        land_size: 1,
        plant: {
            id: 1020307,
            name: '',
            season: 1,
            phases: [
                { phase: 2, phase_id: 3, begin_time: 1000, dry_time: 0, weeds_time: 0, insect_time: 0 },
            ],
        },
    };
    const detail = buildLandDetail(land, { nowSec: 1000 + 3600 });
    assert.equal(detail.plantId, 1020307);
    assert.equal(detail.plantName, '红薯');
    assert.equal(detail.seedId, 20307);
    assert.equal(detail.seedImage, '/game-config/seed_images_named/seed_images/20307.png');
});

test('known crops keep their original name and image', () => {
    const land = {
        id: 2,
        unlocked: true,
        level: 1,
        max_level: 5,
        land_size: 1,
        plant: {
            id: 1020306,
            name: '',
            season: 1,
            phases: [
                { phase: 2, phase_id: 3, begin_time: 1000, dry_time: 0, weeds_time: 0, insect_time: 0 },
            ],
        },
    };
    const detail = buildLandDetail(land, { nowSec: 1000 + 3600 });
    assert.equal(detail.plantName, '芹菜');
    assert.equal(detail.seedId, 20306);
    assert.equal(detail.seedImage, '/game-config/seed_images_named/seed_images/20306.png');
});

test('activity items resolve name, type and image instead of 物品40307', () => {
    const seed = getItemById(20307);
    assert.equal(seed.name, '红薯种子');
    assert.equal(seed.type, 5);
    assert.equal(getItemImageById(20307), '/game-config/seed_images_named/seed_images/20307.png');

    const fruit = getItemById(40307);
    assert.equal(fruit.name, '红薯');
    assert.equal(fruit.type, 6);
    assert.equal(getItemImageById(40307), '/game-config/seed_images_named/seed_images/40307.png');

    const golden = getItemById(1040307);
    assert.equal(golden.name, '黄金·红薯');
    assert.equal(golden.type, 17);
    assert.equal(getItemImageById(1040307), '/game-config/seed_images_named/seed_images/1040307.png');

    // 名称查不到时仍保留原有兜底，不能把未知道具变成“存在”
    assert.equal(getItemById(999999), undefined);
    assert.equal(getItemImageById(999999), '');
});

test('activity crop names cascade to seed, fruit and golden variant', () => {
    assert.equal(getPlantNameBySeedId(20307), '红薯');
    assert.equal(getFruitName(40307), '红薯');
    assert.equal(getPlantName(1020307), '红薯');
    assert.equal(getPlantName(1120307), '黄金·红薯');
    assert.equal(getMutantDisplayPlantId(1020307, [5]), 1120307);
    assert.equal(getMutantDisplayPlantId(1020307, []), 1020307);
});

test('activity items stay out of the auto-planting seed pool', () => {
    assert.equal(getAllSeeds().some(seed => seed.seedId === 20307), false);
});
