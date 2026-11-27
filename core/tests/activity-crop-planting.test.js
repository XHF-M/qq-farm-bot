const test = require('node:test');
const assert = require('node:assert/strict');

/**
 * 活动作物（红薯）参与自动种植的回归锁。
 *
 * 背景：getBagSeeds() 用 `getPlantBySeedId(seedId)` 过滤背包物品，
 * 红薯种子 20307 不在 Plant.json 里，会被静默丢弃，自动种植永远看不到它。
 * 这里用假 BagReply 替换网络层，跑真实的 getBagSeeds 逻辑（不连账号）。
 */

const path = require('node:path');
const CORE = path.resolve(__dirname, '..');

const proto = require(path.join(CORE, 'dist/utils/proto'));
const gameConfig = require(path.join(CORE, 'dist/config/gameConfig'));

test('activity seed is plantable: getPlantBySeedId returns a synthesized plant', () => {
    const plant = gameConfig.getPlantBySeedId(20307);
    assert.ok(plant, '红薯种子应有合成 Plant 条目');
    assert.equal(plant.name, '红薯');
    assert.equal(plant.seed_id, 20307);
    assert.equal(plant.fruit.id, 40307);
    assert.ok(Number(plant.size) >= 1, 'size 用于地块布局，必须 >= 1');
    assert.equal(gameConfig.isActivitySeed(20307), true);
    assert.equal(gameConfig.isActivitySeed(20002), false);
});

test('activity seeds stay out of the shop/config seed pool', () => {
    // getAllSeeds 只来自 Plant.json，活动种子不能混进去（否则商店兜底列表/图鉴会被污染）
    assert.equal(gameConfig.getAllSeeds().some(seed => seed.seedId === 20307), false);
});

test('getBagSeeds picks up 红薯种子 and ignores fruits', async () => {
    await proto.loadProto();
    const { types } = proto;
    assert.ok(types.BagReply, 'BagReply 协议应可用');

    const fakeItems = [
        { id: 20307, count: 5, uid: 9001 },   // 红薯种子
        { id: 20002, count: 12, uid: 9002 },  // 白萝卜种子
        { id: 40307, count: 68, uid: 9003 },  // 红薯果实：不能当种子
        { id: 1040307, count: 7, uid: 9004 }, // 黄金·红薯果实：不能当种子
    ];
    const body = types.BagReply.encode(types.BagReply.create({ item_bag: { items: fakeItems } })).finish();

    // warehouse 用解构赋值拿 sendMsgAsync，必须在它 require 之前替换模块导出
    const netPath = require.resolve(path.join(CORE, 'dist/utils/network'));
    const net = require(netPath);
    const originalSend = net.sendMsgAsync;
    net.sendMsgAsync = async () => ({ body });

    try {
        const warehouse = require(path.join(CORE, 'dist/services/warehouse'));
        const seeds = await warehouse.getBagSeeds();
        const byId = new Map(seeds.map(s => [Number(s.seedId), s]));

        assert.ok(byId.has(20307), `背包应识别出红薯种子，实际: ${[...byId.keys()].join(',')}`);
        assert.equal(byId.get(20307).name, '红薯');
        assert.equal(byId.get(20307).count, 5);
        assert.ok(Number(byId.get(20307).plantSize) >= 1);

        assert.ok(byId.has(20002), '普通种子不受影响');
        assert.equal(byId.has(40307), false, '果实不能被当成种子');
        assert.equal(byId.has(1040307), false, '超变果实不能被当成种子');
    } finally {
        net.sendMsgAsync = originalSend;
    }
});

test('getAvailableSeeds exposes activity seed as a non-purchasable option', async () => {
    // 设置页「优先种植种子」的数据源就是 /api/seeds。活动种子买不到，
    // 但必须能在这里被选中，才能借背包优先顺序把它排到最前。
    const apiPath = require.resolve(path.join(CORE, 'dist/services/farm/api'));
    const api = require(apiPath);
    const originalGetShopInfo = api.getShopInfo;

    api.getShopInfo = async () => ({
        goods_list: [
            { id: 2001, item_id: 20002, price: 100, item_count: 1, unlocked: true, conds: [{ type: 1, param: 1 }], limit_count: 0, bought_num: 0 },
            { id: 2002, item_id: 20306, price: 200, item_count: 1, unlocked: true, conds: [{ type: 1, param: 3 }], limit_count: 0, bought_num: 0 },
        ],
    });

    try {
        const planting = require(path.join(CORE, 'dist/services/farm/planting'));
        const list = await planting.getAvailableSeeds(true);
        const ids = list.map(item => Number(item.seedId));
        assert.ok(ids.includes(20307), `商店种子列表应附带活动种子，实际: ${ids.join(',')}`);

        const activity = list.find(item => Number(item.seedId) === 20307);
        assert.equal(activity.name, '红薯');
        assert.equal(activity.purchasable, false, '必须标记为不可购买，避免前端误下单');
        assert.equal(activity.goodsId, 0);
        assert.equal(activity.price, null);
        assert.equal(activity.locked, false);
        assert.equal(activity.soldOut, false);

        // 活动种子固定排在商店种子之后，不抢默认选项
        assert.equal(ids[ids.length - 1], 20307);
        assert.equal(list.filter(item => item.purchasable === false).length, 1);
        assert.equal(list.filter(item => item.purchasable !== false).length, 2, '商店种子数量不受影响');
    } finally {
        api.getShopInfo = originalGetShopInfo;
    }
});

test('explicit priority puts 红薯种子 first in bag planting order', () => {
    const planting = require(path.join(CORE, 'dist/services/farm/planting'));
    const bag = [
        { seedId: 20002, name: '白萝卜', count: 12, requiredLevel: 1, plantSize: 1 },
        { seedId: 20307, name: '红薯', count: 5, requiredLevel: 0, plantSize: 1 },
        { seedId: 20306, name: '芹菜', count: 3, requiredLevel: 3, plantSize: 1 },
    ];

    const explicit = planting.sortBagSeedsForPlanting(bag, [20307, 20306, 20002]);
    assert.deepEqual(explicit.map(seed => seed.seedId), [20307, 20306, 20002]);

    // 没配优先级时活动种子仍然排在普通种子之前（活动有期限，留着会作废）
    const auto = planting.sortBagSeedsForPlanting(bag, []);
    assert.equal(auto[0].seedId, 20307);
});
