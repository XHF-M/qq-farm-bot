'use strict';

/**
 * 从抓包里提取游戏 CDN 的 server 基址与 bundle 版本号。
 *
 * 抓包只需要包含静态资源请求（.json / .png / .bin），不需要解协议：
 *   <server>/remote/<bundle>/config.<version>.json      ← manifest，版本号来源
 *   <server>/remote/<bundle>/<nativeBase>/<xx>/<uuid>.<hash>.png
 *
 * 拿到这两个值后，就不需要反编译小程序源码了，直接：
 *   node tools/download-game-config.js --cdn-server <server> --bundle-version <version>
 *   node tools/download-game-images.js --cdn-server <server> --bundle-version <bundle>=<version>
 */

const fs = require('node:fs');
const path = require('node:path');

const MANIFEST_RE = /(https?:\/\/[^\s"'<>]+?)\/remote\/([A-Za-z0-9_-]+)\/config\.([A-Za-z0-9_-]+)\.json/g;
const REMOTE_RE = /(https?:\/\/[^\s"'<>]+?)\/remote\/([A-Za-z0-9_-]+)\//g;
const IMAGE_RE = /\/remote\/[A-Za-z0-9_-]+\/[^\s"'<>]*\.png/;

function printUsage() {
    console.log(`用法：
  node tools/extract-cdn-from-capture.js --har <抓包.har>
  node tools/extract-cdn-from-capture.js --text <URL列表.txt>
  node tools/extract-cdn-from-capture.js --url <任意一条资源URL>

参数：
  --har <file>    Chrome / Reqable / Charles 导出的 HAR
  --text <file>   纯文本，每行一条 URL 或整段日志
  --url <url>     直接给一条资源 URL（可重复）
  --json          以 JSON 输出（便于脚本消费）
  -h, --help      显示帮助

说明：
  只读取静态资源 URL，不解析协议包，不需要登录态，不含任何密钥。`);
}

function parseArgs(argv) {
    const options = { har: '', text: '', urls: [], json: false };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '-h' || arg === '--help') {
            printUsage();
            process.exit(0);
        }
        if (arg === '--json') {
            options.json = true;
            continue;
        }
        if (!['--har', '--text', '--url'].includes(arg)) throw new Error(`未知参数: ${arg}`);
        const value = argv[++i];
        if (!value || value.startsWith('--')) throw new Error(`${arg} 缺少参数`);
        if (arg === '--har') options.har = path.resolve(value);
        else if (arg === '--text') options.text = path.resolve(value);
        else options.urls.push(value);
    }
    if (!options.har && !options.text && options.urls.length === 0) {
        printUsage();
        throw new Error('至少提供 --har / --text / --url 之一');
    }
    return options;
}

function collectUrls(options) {
    const urls = [...options.urls];
    if (options.har) {
        let har;
        try {
            har = JSON.parse(fs.readFileSync(options.har, 'utf8'));
        } catch (error) {
            throw new Error(`无法解析 HAR ${options.har}: ${error.message}`);
        }
        const entries = har?.log?.entries;
        if (!Array.isArray(entries)) throw new Error(`HAR 结构无效，缺少 log.entries: ${options.har}`);
        for (const entry of entries) {
            const url = entry?.request?.url;
            if (typeof url === 'string') urls.push(url);
        }
        console.log(`[HAR] ${options.har}: ${entries.length} 条请求`);
    }
    if (options.text) {
        const raw = fs.readFileSync(options.text, 'utf8');
        const found = raw.match(/https?:\/\/[^\s"'<>]+/g) || [];
        urls.push(...found);
        console.log(`[文本] ${options.text}: 提取 ${found.length} 条 URL`);
    }
    return urls;
}

function normalizeServer(server) {
    return server.endsWith('/') ? server : `${server}/`;
}

function extract(urls) {
    const manifests = new Map();
    const bundles = new Map();
    let imageCount = 0;
    let servers = new Map();

    for (const url of urls) {
        let m;
        MANIFEST_RE.lastIndex = 0;
        while ((m = MANIFEST_RE.exec(url))) {
            const server = normalizeServer(m[1]);
            if (!/^https:\/\//i.test(server)) continue;
            manifests.set(`${m[2]}@${m[3]}`, { server, bundle: m[2], version: m[3] });
        }
        REMOTE_RE.lastIndex = 0;
        while ((m = REMOTE_RE.exec(url))) {
            const server = normalizeServer(m[1]);
            if (!/^https:\/\//i.test(server)) continue;
            servers.set(server, (servers.get(server) || 0) + 1);
            const name = m[2];
            if (!bundles.has(name)) bundles.set(name, 0);
            bundles.set(name, bundles.get(name) + 1);
        }
        if (IMAGE_RE.test(url)) imageCount += 1;
    }

    // manifest 里的 server 优先级最高：它一定是资源根
    const serverRank = [...servers.entries()].sort((a, b) => b[1] - a[1]);
    const manifestServers = new Set([...manifests.values()].map(item => item.server));
    const server = manifestServers.size > 0
        ? [...manifestServers][0]
        : (serverRank.length > 0 ? serverRank[0][0] : '');

    return {
        server,
        manifests: [...manifests.values()].filter(item => item.server === server),
        bundles: [...bundles.entries()].map(([name, count]) => ({ name, count })),
        imageCount,
        otherServers: serverRank.map(([value, count]) => ({ server: value, count })).filter(item => item.server !== server),
    };
}

function main() {
    const options = parseArgs(process.argv.slice(2));
    const urls = collectUrls(options);
    if (urls.length === 0) throw new Error('没有从输入中找到任何 URL');
    const result = extract(urls);

    if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
    }

    if (!result.server) {
        console.error('[失败] 没有发现 /remote/<bundle>/ 形式的资源 URL。');
        console.error('       可能原因：抓包内容不含静态资源，或走了另一套 CDN 域名。');
        console.error('       建议：清掉小游戏缓存后重新进入游戏，从头抓一遍。');
        process.exit(1);
    }

    console.log(`[CDN]    ${result.server}`);
    if (result.manifests.length > 0) {
        for (const item of result.manifests) {
            console.log(`[bundle] ${item.bundle} = ${item.version}   (来自 config.<版本>.json)`);
        }
    } else {
        console.log('[bundle] 未找到 config.<版本>.json 请求，拿不到版本号。');
        console.log('         请清缓存后重抓，或从抓包请求列表里找形如 .../remote/xxx/config.abc123.json 的一条。');
    }
    if (result.bundles.length > 0) {
        console.log(`[资源]   出现的 bundle：${result.bundles.map(item => `${item.name}(${item.count})`).join(', ')}`);
    }
    console.log(`[图片]   PNG 请求 ${result.imageCount} 条`);
    if (result.otherServers.length > 0) {
        console.log(`[其他]   还有 ${result.otherServers.length} 个候选 CDN 域名，未采用：`);
        for (const item of result.otherServers.slice(0, 5)) {
            console.log(`         ${item.server}  (${item.count})`);
        }
    }

    if (result.manifests.length > 0) {
        const spec = result.manifests.map(item => `${item.bundle}=${item.version}`).join(',');
        const main = result.manifests.find(item => item.bundle === 'mainscene') || result.manifests[0];
        console.log('\n下一步（复制执行）：');
        console.log(`  node tools/download-game-config.js --cdn-server "${result.server}" --bundle-version ${main.version}`);
        console.log(`  node tools/download-game-images.js --cdn-server "${result.server}" --bundle-version ${spec}`);
    }
}

try {
    main();
} catch (error) {
    console.error(`[错误] ${error.message}`);
    process.exit(1);
}
