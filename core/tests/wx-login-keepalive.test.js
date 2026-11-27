const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// buffer-store 用 getDataDir() 定位，后者每次调用都读 FARM_DATA_DIR，
// 所以在 require 之前把数据目录指到临时目录，避免污染真实 data。
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-keepalive-'));
process.env.FARM_DATA_DIR = dataDir;

const {
    rememberPendingBuffer,
    bindPendingBufferToAccount,
    getAccountBuffer,
    hasAccountBuffer,
    dropAccountBuffer,
    codeKey,
} = require('../dist/services/wx-login/buffer-store');
const native = require('../dist/services/wx-login/native-protocol');
const {
    createAutoRelogin,
    resolveAutoReloginOptions,
    isOtherTerminalKick,
} = require('../dist/runtime/auto-relogin');

function bindBuffer(accountId, code, buffer) {
    rememberPendingBuffer(code, { buffer, openid: `openid-${accountId}` });
    return bindPendingBufferToAccount(code, accountId);
}

test('loginBuffer 按账号加密落盘，能原样取回', () => {
    assert.equal(bindBuffer('1', 'CODE-ONE', 'buffer-payload-1'), true);
    const record = getAccountBuffer('1');
    assert.ok(record);
    assert.equal(record.buffer, 'buffer-payload-1');
    assert.equal(record.openid, 'openid-1');

    const file = path.join(dataDir, 'wx-login-buffers', '1.json');
    const raw = fs.readFileSync(file, 'utf8');
    assert.ok(!raw.includes('buffer-payload-1'), '落盘内容不应是明文');
    assert.ok(!raw.includes('openid-1'), 'openid 也应被加密');
});

test('同一 code 只能被认领一次，手工粘贴的 code 无缓冲', () => {
    assert.equal(bindBuffer('2', 'CODE-TWO', 'buffer-2'), true);
    // 第二次认领时 pending 已删除
    assert.equal(bindPendingBufferToAccount('CODE-TWO', '2'), false);
    // 没有经过扫码的 code（手工粘贴）无法绑定
    assert.equal(bindPendingBufferToAccount('MANUAL-CODE', '3'), false);
    assert.equal(hasAccountBuffer('3'), false);
});

test('删除账号时清理登录缓冲', () => {
    dropAccountBuffer('2');
    assert.equal(hasAccountBuffer('2'), false);
});

test('code 键不暴露明文', () => {
    assert.equal(codeKey('CODE-ONE').length, 64);
    assert.ok(!codeKey('CODE-ONE').includes('CODE'));
});

test('reasonCode=1 判定为其他终端登录', () => {
    assert.equal(isOtherTerminalKick(1, ''), true);
    assert.equal(isOtherTerminalKick(0, '已在其他终端登录'), true);
    assert.equal(isOtherTerminalKick(0, 'Unexpected server response: 400'), false);
});

function createHarness(accountId, options = {}) {
    const timers = new Map();
    const cleared = new Set();
    const logs = [];
    const started = [];
    const account = { id: accountId, name: `acc-${accountId}`, code: 'OLD-CODE' };

    const scheduler = {
        setTimeoutTask(name, ms, fn) {
            timers.set(name, { ms, fn });
            return name;
        },
        clear(name) {
            cleared.add(name);
            timers.delete(name);
        },
    };

    const deps = {
        scheduler,
        log: () => {},
        addAccountLog: (action, message, id, name, extra) => logs.push({ action, message, id, name, extra }),
        getAccount: () => account,
        applyNewCode: (_id, code) => {
            account.code = code;
            return account;
        },
        startAccount: async (acc) => { started.push(acc.code); },
        isRunning: () => false,
        isActive: () => true,
    };

    const resolved = resolveAutoReloginOptions(options.env || {});
    const runner = createAutoRelogin(deps, resolved);
    return { runner, account, logs, started, timers, cleared, options: resolved };
}

const flush = () => new Promise(resolve => setTimeout(resolve, 20));

test('被踢下线：先等 20 分钟再自动换 code 重连', async () => {
    const original = native.getNativeWxLoginCode;
    const issued = [];
    native.getNativeWxLoginCode = async (buffer, appId) => {
        issued.push({ buffer, appId });
        return `NEW-CODE-${issued.length}`;
    };
    try {
        bindBuffer('10', 'CODE-TEN', 'buffer-10');
        const h = createHarness('10');
        const handled = h.runner.notifyDisconnected('10', { reasonCode: 1, reason: '已在其他终端登录' });
        assert.equal(handled, true, '有 loginBuffer 时应接管重登');

        const timer = h.timers.get('auto_relogin_retry_10');
        assert.ok(timer, '应排入重登任务');
        assert.equal(timer.ms, 20 * 60 * 1000, '人工登录顶下线时首轮等待 20 分钟，避免互踢');

        timer.fn();
        await flush();

        assert.equal(issued.length, 1);
        assert.equal(issued[0].buffer, 'buffer-10');
        assert.equal(issued[0].appId, 'wx5306c5978fdb76e4');
        assert.deepEqual(h.started, ['NEW-CODE-1']);
        assert.equal(h.account.code, 'NEW-CODE-1');
        assert.ok(h.logs.some(entry => entry.action === 'auto_relogin_ok'));
    } finally {
        native.getNativeWxLoginCode = original;
    }
});

test('code 过期（400）：不等 20 分钟，90 秒后快速重试', async () => {
    const original = native.getNativeWxLoginCode;
    native.getNativeWxLoginCode = async () => 'NEW-CODE-FAST';
    try {
        bindBuffer('11', 'CODE-ELEVEN', 'buffer-11');
        const h = createHarness('11');
        assert.equal(h.runner.notifyDisconnected('11', { code: 400, reason: 'Unexpected server response: 400' }), true);
        const timer = h.timers.get('auto_relogin_retry_11');
        assert.ok(timer);
        assert.equal(timer.ms, 90 * 1000);
    } finally {
        native.getNativeWxLoginCode = original;
    }
});

test('没有 loginBuffer 时保持原有行为，提示手动扫码', () => {
    const h = createHarness('12');
    assert.equal(h.runner.notifyDisconnected('12', { reasonCode: 1 }), false);
    assert.equal(h.timers.size, 0);
});

test('换 code 失败按指数退避，连续失败后放弃', async () => {
    const original = native.getNativeWxLoginCode;
    let calls = 0;
    native.getNativeWxLoginCode = async () => {
        calls += 1;
        throw new Error('ShortLink AppData decrypt/parse failed');
    };
    try {
        bindBuffer('13', 'CODE-13', 'buffer-13');
        const h = createHarness('13', { env: { FARM_AUTO_RELOGIN_DELAY_MIN: '1' } });
        assert.equal(h.options.baseDelayMs, 60 * 1000);

        h.runner.notifyDisconnected('13', { reasonCode: 1 });
        let timer = h.timers.get('auto_relogin_retry_13');
        assert.equal(timer.ms, 60 * 1000);

        timer.fn();
        await flush();
        assert.equal(calls, 1);
        timer = h.timers.get('auto_relogin_retry_13');
        assert.equal(timer.ms, 120 * 1000, '第二次失败后等 2×base');

        // 第 2 次尝试后仍失败 → 4×base
        timer.fn();
        await flush();
        timer = h.timers.get('auto_relogin_retry_13');
        assert.equal(timer.ms, 240 * 1000);

        // 一路失败到上限后放弃，不再排任务
        for (let i = 0; i < 10; i++) {
            const pending = h.timers.get('auto_relogin_retry_13');
            if (!pending) break;
            pending.fn();
            await flush();
        }
        assert.equal(h.timers.has('auto_relogin_retry_13'), false);
        assert.ok(h.logs.some(entry => entry.action === 'auto_relogin_giveup'));
        assert.equal(h.runner.notifyDisconnected('13', { reasonCode: 1 }), false);
    } finally {
        native.getNativeWxLoginCode = original;
    }
});

test('连接稳定 10 分钟后清零退避', async () => {
    const original = Date.now;
    try {
        bindBuffer('14', 'CODE-14', 'buffer-14');
        const h = createHarness('14');
        h.runner.notifyDisconnected('14', { reasonCode: 1 });
        h.runner.markOnline('14');
        const stable = h.timers.get('auto_relogin_stable_14');
        assert.ok(stable, '应排入稳定判定');
        assert.equal(stable.ms, 10 * 60 * 1000);

        // 稳定判定触发后状态被清空，下一次掉线重新从 base 起算
        stable.fn();
        const next = h.runner.notifyDisconnected('14', { reasonCode: 1 });
        assert.equal(next, true);
        const timer = h.timers.get('auto_relogin_retry_14');
        assert.equal(timer.ms, 20 * 60 * 1000);
    } finally {
        Date.now = original;
    }
});

test('关闭开关后不接管', () => {
    bindBuffer('15', 'CODE-15', 'buffer-15');
    const h = createHarness('15', { env: { FARM_AUTO_RELOGIN: '0' } });
    assert.equal(h.options.enabled, false);
    assert.equal(h.runner.notifyDisconnected('15', { reasonCode: 1 }), false);
    assert.equal(h.timers.size, 0);
});

test('登录凭据本身失效：立刻放弃并清掉缓冲，不做无谓重试', async () => {
    const original = native.getNativeWxLoginCode;
    let calls = 0;
    native.getNativeWxLoginCode = async () => {
        calls += 1;
        throw new Error('ManualAuth rejected: code=123 message=expired ticket');
    };
    try {
        bindBuffer('16', 'CODE-16', 'buffer-16');
        const h = createHarness('16');
        assert.equal(h.runner.notifyDisconnected('16', { reasonCode: 1 }), true);
        const timer = h.timers.get('auto_relogin_retry_16');
        timer.fn();
        await flush();

        assert.equal(calls, 1);
        assert.equal(h.timers.has('auto_relogin_retry_16'), false, '凭据失效不应再排重试');
        assert.equal(hasAccountBuffer('16'), false, '失效的登录缓冲应被清掉');
        assert.ok(h.logs.some(entry => entry.action === 'auto_relogin_expired'));
    } finally {
        native.getNativeWxLoginCode = original;
    }
});

test('账号写入扫码得到的 code 时自动认领 loginBuffer', () => {
    const { addOrUpdateAccount } = require('../dist/models/store/accounts');

    rememberPendingBuffer('CODE-ACC-WX', { buffer: 'buffer-acc-wx', openid: 'oid-wx' });
    const wxData = addOrUpdateAccount({ name: '测试微信号', code: 'CODE-ACC-WX', platform: 'wx' });
    const wxAccount = wxData.accounts.at(-1);
    assert.ok(wxAccount && wxAccount.id);
    assert.equal(hasAccountBuffer(wxAccount.id), true, '微信账号应绑上登录缓冲');
    assert.equal(getAccountBuffer(wxAccount.id).buffer, 'buffer-acc-wx');

    rememberPendingBuffer('CODE-ACC-QQ', { buffer: 'buffer-acc-qq', openid: 'oid-qq' });
    const qqData = addOrUpdateAccount({ name: '测试QQ号', code: 'CODE-ACC-QQ', platform: 'qq' });
    const qqAccount = qqData.accounts.at(-1);
    assert.ok(qqAccount && qqAccount.id);
    assert.equal(hasAccountBuffer(qqAccount.id), false, 'QQ 账号不应绑定微信登录缓冲');
});
