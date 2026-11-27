#!/usr/bin/env node
/**
 * 扫描 HAR，找小游戏静态资源 CDN 请求（重点：plant bundle 版本号）。
 *
 *   node tools/har-scan.js <file.har> [--grep <pattern>]
 *
 * 输出：
 *   1. 域名统计
 *   2. 命中 --grep 的 URL（默认匹配 plant / remote/  / Crop_307）
 *   3. 所有候选的 Cocos 资源 CDN URL（含 config.<版本>.json / .json / .png 的 remote 路径）
 *
 * 注意：HAR 里可能含 cookie / token，本脚本只打印 URL 与状态码，不打印请求头。
 */
const fs = require('fs');

const file = process.argv[2];
if (!file) {
    console.error('用法: node tools/har-scan.js <file.har> [--grep <pattern>]');
    process.exit(1);
}

const gi = process.argv.indexOf('--grep');
const pattern = gi > 0 ? process.argv[gi + 1] : null;

let raw = fs.readFileSync(file, 'utf8');
// 去 BOM（Fiddler 导出的 HAR 带 UTF-8 BOM，JSON.parse 会直接报错）
if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
const har = JSON.parse(raw);
const entries = (har.log && har.log.entries) || [];

console.log(`total entries: ${entries.length}`);

const hosts = new Map();
for (const e of entries) {
    let host = '(invalid)';
    try { host = new URL(e.request.url).host; } catch (_) { /* CONNECT 之类的怪 URL */ }
    hosts.set(host, (hosts.get(host) || 0) + 1);
}

console.log('\n=== hosts ===');
[...hosts.entries()]
    .sort((a, b) => b[1] - a[1])
    .forEach(([h, c]) => console.log(String(c).padStart(6), h));

const re = pattern ? new RegExp(pattern, 'i') : null;
const hits = [];
for (const e of entries) {
    const url = e.request.url || '';
    if (re && !re.test(url)) continue;
    if (!re) continue;
    hits.push({
        url,
        method: e.request.method,
        status: e.response && e.response.status,
        size: e.response && e.response.content && e.response.content.size,
        mime: e.response && e.response.content && e.response.content.mimeType,
    });
}

console.log(`\n=== 命中 ${pattern || '(无 pattern)'}: ${hits.length} 条 ===`);
for (const h of hits) {
    console.log(`[${h.status}] ${h.method} ${h.url}  (${h.mime || '-'}, ${h.size || 0}B)`);
}

// 罗列所有带 remote/ 的 URL —— Cocos 的 bundle 资源都走这个前缀
const remote = entries
    .map(e => e.request.url || '')
    .filter(u => /\/remote\//.test(u));
console.log(`\n=== remote/* 资源: ${remote.length} 条 ===`);
for (const u of remote.slice(0, 200)) console.log(u);

// CONNECT 隧道 = 抓包工具没能解密的 HTTPS。解密失败通常是客户端做了证书校验（pinning）
const tunnels = entries.filter(e => (e.request.method || '').toUpperCase() === 'CONNECT');
const decoded = entries.length - tunnels.length;
console.log(`\n=== 解密情况: 已解密 ${decoded} 条 / 仅隧道 ${tunnels.length} 条 ===`);

const tunnelHosts = new Map();
for (const e of tunnels) {
    const h = (e.request.url || '').replace(/^https?:\/\//i, '').replace(/:443$/, '');
    tunnelHosts.set(h, (tunnelHosts.get(h) || 0) + 1);
}
console.log('--- 未解密域名（客户端 pinning 或握手失败） ---');
[...tunnelHosts.entries()]
    .sort((a, b) => b[1] - a[1])
    .forEach(([h, c]) => console.log(String(c).padStart(5), h));

// 隧道的时间线：挨在一起的 CONNECT 往往是同一批资源加载
const near = tunnels.filter(e => /nqf|cdn/i.test(e.request.url));
if (near.length) {
    console.log('\n--- CDN 隧道时间线 ---');
    for (const e of near) console.log(e.startedDateTime, e.request.url);
}
