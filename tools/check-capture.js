#!/usr/bin/env node
/**
 * 抓包结果检查器
 *
 * 读 .capture/asset-urls.log（由 tools/sniff-asset-urls.js 写出），判断这次抓包
 * 有没有拿到目标 bundle 的版本号，并把可直接执行的下载命令打印出来。
 *
 * 用法：
 *   node tools/check-capture.js                  # 检查 plant（默认目标）
 *   node tools/check-capture.js --bundle extraRes
 *   node tools/check-capture.js --all            # 列出日志里出现过的所有 bundle
 *   node tools/check-capture.js --log <路径>      # 指定日志文件
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_LOG = path.join(ROOT, '.capture', 'asset-urls.log');

const argv = process.argv.slice(2);
function option(name, fallback) {
    const index = argv.indexOf(name);
    if (index === -1) return fallback;
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${name} 缺少参数值`);
    return value;
}

const LOG = path.resolve(option('--log', DEFAULT_LOG));
const TARGET = option('--bundle', 'plant');
const SHOW_ALL = argv.includes('--all');

// remote/<bundle>/config.<version>.json
const BUNDLE_CONFIG = /\/remote\/([^/?#]+)\/config\.([0-9a-z]+)\.json/i;
// remote/<bundle>/native/<uuid>.<hash>.<ext>  或 remote/<bundle>/<子目录>/<文件>.<ext>
const BUNDLE_ASSET = /\/remote\/([^/?#]+)\/([^?#]+)\.(astc|png|jpg|webp|json|plist|skel|atlas|bin|mp3|ogg)(?:\?|$)/i;

function readLines(file) {
    if (!fs.existsSync(file)) return null;
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
}

const lines = readLines(LOG);
if (lines === null) {
    console.error(`找不到日志：${LOG}`);
    console.error('先启动代理：node tools/sniff-asset-urls.js --port 18000');
    process.exit(1);
}

// 微信小游戏启动时必定经过的域名。一个都没有 = 游戏根本没跑起来
// （代码包由微信 CDN 下发，即使命中缓存，冷启动也会握手）
const GAME_HOST_HINTS = [
    /(^|\.)servicewechat\.com$/i,
    /(^|\.)wximg\.qq\.com$/i,
    /(^|\.)wxapp\.tc\.qq\.com$/i,
    /(^|\.)pkg\.wxqcloud\.qq\.com$/i,
    /(^|\.)wxagame\.qq\.com$/i,
];

const configs = new Map();   // bundle -> version
const assets = new Map();    // bundle -> Set(相对路径)
let assetLines = 0;
let firstAt = '';
let lastAt = '';
const otherHosts = new Map();
const gameHosts = new Map(); // 命中的小游戏特征域名

for (const line of lines) {
    const match = line.match(/^(\S+Z)\s+(ASSET|REQ  |CONN)\s+(\S+)/);
    if (!match) continue;
    const [, time, tag, url] = match;
    if (tag === 'ASSET') {
        assetLines += 1;
        if (!firstAt) firstAt = time;
        lastAt = time;
    }
    const cfg = url.match(BUNDLE_CONFIG);
    if (cfg) configs.set(cfg[1], cfg[2]);
    const as = url.match(BUNDLE_ASSET);
    if (as) {
        const [, bundle, rel] = as;
        if (!assets.has(bundle)) assets.set(bundle, new Set());
        assets.get(bundle).add(rel);
    }
    if (tag === 'REQ  ' || tag === 'CONN') {
        try {
            const host = new URL(url).host;
            otherHosts.set(host, (otherHosts.get(host) || 0) + 1);
            if (GAME_HOST_HINTS.some(re => re.test(host))) {
                gameHosts.set(host, (gameHosts.get(host) || 0) + 1);
            }
        } catch { /* 忽略畸形 URL */ }
    }
}

console.log('================ 抓包结果检查 ================');
console.log(`日志文件 : ${LOG}`);
console.log(`总行数   : ${lines.length}   资源行(ASSET): ${assetLines}`);
if (firstAt) console.log(`时间范围 : ${firstAt} ~ ${lastAt}`);
console.log();

if (configs.size === 0 && assets.size === 0) {
    console.log('❌ 日志里没有任何 CDN 资源请求。');
    console.log();
    console.log('常见原因（按可能性排序）：');
    console.log('  1. 手机没连上代理          → 代理控制台应能看到 CONN/REQ 行');
    console.log('  2. 根证书没被信任          → 只有 CONN，没有 ASSET（HTTPS 建连后立刻断开）');
    console.log('  3. 小游戏命中缓存没发请求  → 必须清缓存后重进');
    console.log('  4. 手机 WiFi 代理没生效    → 换个站点确认代理是否在转发');
    if (otherHosts.size > 0) {
        console.log();
        console.log('日志里出现过的其他域名（说明代理至少在转发）：');
        for (const [host, count] of [...otherHosts].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
            console.log(`  ${host}  x${count}`);
        }
    }
    process.exit(2);
}

const rows = [...configs].map(([bundle, ver]) => ({
    bundle,
    version: ver,
    assetCount: assets.has(bundle) ? assets.get(bundle).size : 0,
}));

console.log('抓到的 bundle 清单：');
console.log('  bundle          版本号     具体资源数');
console.log('  --------------  ---------  ----------');
for (const row of rows) {
    console.log(`  ${row.bundle.padEnd(14)}  ${row.version.padEnd(9)}  ${String(row.assetCount).padStart(10)}`);
}
console.log();

// 先判断「游戏有没有真正跑起来」，这比 bundle 清单更能定位问题
if (gameHosts.size === 0) {
    console.log('⚠️  没有发现微信小游戏启动域名（servicewechat.com / wximg.qq.com / pkg.wxqcloud 等）。');
    console.log('    → 小游戏本体没有启动，这次只抓到了浏览器和微信首页的流量。');
    console.log('    证书通常没问题（能解密就说明 CA 已信任），问题在「没点进游戏」或「卡在加载页」。');
    console.log();
} else {
    console.log('✅ 小游戏启动域名已出现：' + [...gameHosts.keys()].join(', '));
    console.log();
}

if (SHOW_ALL) {
    for (const [bundle, set] of assets) {
        console.log(`--- ${bundle} 的资源（最多列 40 条）---`);
        for (const rel of [...set].slice(0, 40)) console.log('  ' + rel);
        if (set.size > 40) console.log(`  ...（共 ${set.size} 条）`);
        console.log();
    }
}

const hit = configs.get(TARGET);
if (!hit) {
    console.log(`❌ 目标 bundle「${TARGET}」没抓到。`);
    console.log();
    console.log('  已经抓到：' + (rows.map(r => r.bundle).join(', ') || '（无）'));
    if (gameHosts.size === 0) {
        console.log('  而且小游戏压根没启动 —— 先把游戏真正跑起来，缓存问题还轮不到。');
    } else {
        console.log('  游戏启动了，但只有缓存失效的包发了请求。要抓 plant，必须彻底清掉小游戏缓存后重进。');
    }
    process.exit(3);
}

console.log(`✅ 命中：${TARGET} 的版本号是 ${hit}`);
console.log();

// 顺手看看有没有红薯相关资源（即使 manifest 没下到也能提供线索）
const targetAssets = assets.get(TARGET) || new Set();
const cropHit = [...targetAssets].filter(rel => /Crop_30[0-9]/i.test(rel));
if (cropHit.length) {
    console.log('该 bundle 里出现的 Crop_30x 资源：');
    for (const rel of cropHit.slice(0, 20)) console.log('  ' + rel);
    console.log();
}

console.log('下一步 —— 生成一份只含活动条目的最小输入目录，然后下载：');
console.log();
console.log('  node -e "');
console.log('    const fs=require(\'fs\'),p=require(\'path\');');
console.log('    const dir=\'.tmp-activity-cfg\';');
console.log('    fs.mkdirSync(dir,{recursive:true});');
console.log('    fs.writeFileSync(p.join(dir,\'ItemInfo.json\'),\'[]\');');
console.log('    fs.writeFileSync(p.join(dir,\'Plant.json\'),\'[]\');');
console.log('  "');
console.log();
console.log('  node tools/download-game-images.js \\');
console.log('    --input .tmp-activity-cfg \\');
console.log('    --output core/src/gameConfig/seed_images_named/seed_images \\');
console.log('    --cdn-server https://cdn-resource.nqf.qq.com/release/ \\');
console.log(`    --bundle-version ${TARGET}=${hit} \\`);
console.log('    --extra-items "20307:Crop_307,40307:Crop_307,1040307:gold/Crop_307"');
console.log();
