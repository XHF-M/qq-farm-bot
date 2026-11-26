#!/usr/bin/env node
/**
 * 资源 URL 嗅探代理（只记录 URL，不解密内容正文）
 *
 * 用途：拿到 QQ 农场客户端真实请求的静态资源地址。
 * 官方贴图是按 bundle 版本 hash 组织的（remote/plant/config.<ver>.json →
 * native/<uuid>.<hash>.astc），没有版本号就无法拼出 URL，所以必须先看一次
 * 真实客户端流量。
 *
 * 与 core/src/capture 的区别：那套是「协议抓包」，目标是登录 code 和好友 GID，
 * 依赖 node-forge / protobuf 解析、自带会话管理和 REST API；本脚本只做一件事
 * —— 把经过代理的 HTTPS / HTTP 请求 URL 记录到 .capture/asset-urls.log。
 *
 * 用法：
 *   node tools/sniff-asset-urls.js                 # 默认端口 18000
 *   node tools/sniff-asset-urls.js --port 18000
 *   node tools/sniff-asset-urls.js --reset         # 重新生成 CA 与证书
 *   node tools/sniff-asset-urls.js --mitm-all      # 所有域名都解密（默认只解 qq.com 系）
 *
 * 手机侧：连同一 WiFi → 手动代理指向本机 IP:端口 → 浏览器打开
 * http://<本机IP>:<端口>/ca.crt 安装根证书 → 打开 QQ 农场停留一会儿。
 */

'use strict';

const fs = require('node:fs');
const net = require('node:net');
const tls = require('node:tls');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const CAPTURE_DIR = path.join(ROOT, '.capture');
const CERT_DIR = path.join(CAPTURE_DIR, 'certs');
const LOG_FILE = path.join(CAPTURE_DIR, 'asset-urls.log');

const argv = process.argv.slice(2);
function option(name, fallback) {
    const index = argv.indexOf(name);
    if (index === -1) return fallback;
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${name} 缺少参数值`);
    return value;
}
const PORT = Number(option('--port', '18000'));
const MITM_ALL = argv.includes('--mitm-all');
const RESET = argv.includes('--reset');

if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65535) {
    console.error(`端口无效: ${PORT}`);
    process.exit(1);
}

/** 需要解密的域名。CDN 与网关都在 qq.com 下，非 QQ 域名直接隧道。 */
const CAPTURE_HOSTS = [
    /(^|\.)qq\.com$/i,
    /(^|\.)gtimg\.com$/i,
    /(^|\.)qpic\.cn$/i,
];
/** 值得高亮的资源类 URL */
const ASSET_HINT = /(\/config\.[0-9a-z]+\.json|\.astc(\?|$)|\.png(\?|$)|\.jpg(\?|$)|\.webp(\?|$)|\.json(\?|$))/i;

fs.mkdirSync(CERT_DIR, { recursive: true });

/* ------------------------------------------------------------------ 证书 */

function findOpenssl() {
    const candidates = [
        'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
        'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe',
        '/usr/bin/openssl',
        '/usr/local/bin/openssl',
        '/opt/homebrew/bin/openssl',
    ];
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) return candidate;
    }
    try {
        execFileSync('openssl', ['version'], { stdio: 'ignore' });
        return 'openssl';
    } catch {
        return '';
    }
}

function writeSanConfig(file) {
    const san = [
        'DNS:*.qq.com',
        'DNS:*.nqf.qq.com',
        'DNS:*.qzone.qq.com',
        'DNS:q.qq.com',
        'DNS:*.gtimg.com',
        'DNS:localhost',
        'IP:127.0.0.1',
    ].join(',');
    fs.writeFileSync(file, [
        '[req]',
        'distinguished_name=dn',
        '[dn]',
        '[ext]',
        'basicConstraints=CA:FALSE',
        'keyUsage=digitalSignature,keyEncipherment',
        'extendedKeyUsage=serverAuth',
        `subjectAltName=${san}`,
        '',
    ].join('\n'));
}

function ensureCerts() {
    const caCrt = path.join(CERT_DIR, 'ca.crt');
    const caKey = path.join(CERT_DIR, 'ca.key');
    const caDer = path.join(CERT_DIR, 'ca.der');
    const srvCrt = path.join(CERT_DIR, 'server.crt');
    const srvKey = path.join(CERT_DIR, 'server.key');
    const stamp = path.join(CERT_DIR, '.ready');

    if (!RESET && [caCrt, caKey, caDer, srvCrt, srvKey, stamp].every(f => fs.existsSync(f))) {
        return { caCrt, caDer, srvCrt, srvKey };
    }

    const openssl = findOpenssl();
    if (!openssl) {
        throw new Error('未找到 openssl。请安装 openssl，或把 Git 的 usr/bin 目录加入 PATH。');
    }
    const run = (args) => execFileSync(openssl, args, { cwd: CERT_DIR, stdio: 'pipe' });

    const sanFile = path.join(CERT_DIR, 'san.cnf');
    writeSanConfig(sanFile);

    // 根 CA
    run([
        'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '3650', '-nodes',
        '-keyout', 'ca.key', '-out', 'ca.crt',
        '-subj', '/CN=QQFarm Asset Sniffer CA/O=Local Only',
    ]);
    // Android 部分机型只认 DER 的 .cer，额外导出一份
    run(['x509', '-in', 'ca.crt', '-outform', 'der', '-out', 'ca.der']);
    // 服务器证书（多 SAN 通配，覆盖 qq.com / nqf.qq.com / qzone.qq.com）
    run([
        'req', '-newkey', 'rsa:2048', '-sha256', '-nodes',
        '-keyout', 'server.key', '-out', 'server.csr',
        '-subj', '/CN=cdn-resource.nqf.qq.com',
    ]);
    run([
        'x509', '-req', '-in', 'server.csr',
        '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial',
        '-out', 'server.crt', '-days', '825', '-sha256',
        '-extfile', 'san.cnf', '-extensions', 'ext',
    ]);

    fs.writeFileSync(stamp, new Date().toISOString());
    return { caCrt, caDer, srvCrt, srvKey };
}

/* --------------------------------------------------------------- 日志记录 */

const seen = new Set();
let assetCount = 0;

let connectCount = 0;

function record(url, host, kind) {
    if (seen.has(url)) return;
    seen.add(url);
    const isAsset = ASSET_HINT.test(url);
    if (isAsset) assetCount += 1;
    if (kind === 'connect') connectCount += 1;
    const tag = kind === 'connect' ? 'CONN ' : (isAsset ? 'ASSET' : 'REQ  ');
    const line = `${new Date().toISOString()} ${tag} ${url}`;
    fs.appendFileSync(LOG_FILE, `${line}\n`);
    if (kind === 'connect') {
        console.log(`  [隧道] ${url}`);
    } else if (isAsset) {
        console.log(`  [资源] ${url}`);
    }
}

/**
 * 从已解密的明文流里截出 HTTP 请求行。
 * 跨 chunk 的请求行靠保留尾部 4KB 处理。
 */
function makeRequestScanner(host) {
    let pending = '';
    return (chunk) => {
        pending += chunk.toString('latin1');
        const re = /(?:^|\r\n)([A-Z]{3,7}) (\S+) HTTP\/1\.[01]\r\n/g;
        let match;
        let lastIndex = 0;
        while ((match = re.exec(pending)) !== null) {
            const method = match[1];
            const target = match[2];
            lastIndex = re.lastIndex;
            if (method === 'CONNECT' || target.startsWith('/')) {
                record(`https://${host}${target}`, host);
            } else {
                record(target, host);
            }
        }
        if (lastIndex > 0) pending = pending.slice(lastIndex);
        if (pending.length > 8192) pending = pending.slice(-4096);
    };
}

/* ---------------------------------------------------------------- 代理逻辑 */

function shouldMitm(host) {
    if (MITM_ALL) return true;
    return CAPTURE_HOSTS.some(re => re.test(host));
}

function tunnel(socket, host, port, rest) {
    const upstream = net.connect({ host, port });
    upstream.once('connect', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (rest && rest.length) upstream.write(rest);
        socket.on('data', chunk => upstream.write(chunk));
        upstream.on('data', chunk => socket.write(chunk));
    });
    const kill = () => { socket.destroy(); upstream.destroy(); };
    upstream.on('error', kill);
    socket.on('error', kill);
    upstream.on('close', kill);
    socket.on('close', kill);
}

function mitm(socket, host, port, certs) {
    let secureContext;
    try {
        secureContext = tls.createSecureContext({
            key: fs.readFileSync(certs.srvKey),
            cert: fs.readFileSync(certs.srvCrt),
        });
    } catch (error) {
        console.error(`[证书] 加载失败: ${error.message}`);
        socket.destroy();
        return;
    }

    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');

    const client = new tls.TLSSocket(socket, {
        isServer: true,
        secureContext,
        ALPNProtocols: ['http/1.1'],
    });
    const upstream = tls.connect({
        host,
        port,
        servername: host,
        ALPNProtocols: ['http/1.1'],
        rejectUnauthorized: false,
    });

    const scan = makeRequestScanner(host);
    client.on('data', (chunk) => {
        try { scan(chunk); } catch { /* 解析失败不影响转发 */ }
        upstream.write(chunk);
    });
    upstream.on('data', chunk => client.write(chunk));

    const kill = () => {
        client.destroy();
        upstream.destroy();
        socket.destroy();
    };
    client.on('error', kill);
    upstream.on('error', kill);
    client.on('close', kill);
    upstream.on('close', kill);
}

/* ------------------------------------------------------- 明文 HTTP + 证书页 */

function localAddresses() {
    const result = [];
    for (const list of Object.values(os.networkInterfaces())) {
        for (const item of list || []) {
            if (item.family === 'IPv4' && !item.internal) result.push(item.address);
        }
    }
    return result;
}

function guidePage(port) {
    const ips = localAddresses();
    const rows = ips.map(ip => `<tr><td><code>${ip}:${port}</code></td>
<td><a href="http://${ip}:${port}/ca.crt">ca.crt</a> / <a href="http://${ip}:${port}/ca.der">ca.der</a></td></tr>`).join('');
    return `<!doctype html><meta charset="utf-8"><title>QQ 农场资源嗅探</title>
<style>body{font:15px/1.7 system-ui;padding:24px;max-width:760px;margin:auto;background:#111;color:#eee}
code{background:#222;padding:2px 6px;border-radius:4px}a{color:#6bd}td{padding:4px 12px 4px 0}ol{padding-left:22px}</style>
<h2>手机端配置</h2><ol>
<li>手机连接与本机相同的 WiFi</li>
<li>WiFi 高级设置 → 手动代理 → 服务器填下表 IP，端口 ${port}</li>
<li>按下表链接下载根证书并安装、信任（Android 走 ca.der，iOS 走 ca.crt）</li>
<li>打开 QQ → 进入农场，玩到能看到红薯地块</li>
</ol>
<table>${rows || '<tr><td>未检测到内网 IPv4</td></tr>'}</table>
<p style="color:#888">本页面只在本机运行，证书仅用于解密本机流量，不记录请求正文。</p>`;
}

function handlePlain(socket, head, rest, certs) {
    const text = head.toString('latin1');
    const lines = text.split('\r\n');
    const [method, rawTarget] = (lines[0] || '').split(' ');
    const hostHeader = (lines.find(l => /^host:/i.test(l)) || '').replace(/^host:\s*/i, '').trim();

    // 走代理时请求行可能是绝对 URL（GET http://ip:port/ca.crt），也可能只有路径
    let pathname = rawTarget || '';
    let absolute = null;
    if (/^https?:\/\//i.test(pathname)) {
        try {
            absolute = new URL(pathname);
            pathname = absolute.pathname;
        } catch { /* 保持原样 */ }
    }

    const send = (status, headers, body) => {
        const head = [`HTTP/1.1 ${status}`, ...headers, `Content-Length: ${body.length}`, 'Connection: close', '', ''].join('\r\n');
        socket.end(Buffer.concat([Buffer.from(head, 'latin1'), body]));
    };

    if (method === 'GET' && (pathname === '/ca.crt' || pathname === '/cert' || pathname === '/ca')) {
        send('200 OK', [
            'Content-Type: application/x-x509-ca-cert',
            'Content-Disposition: attachment; filename="qqfarm-ca.crt"',
        ], fs.readFileSync(certs.caCrt));
        return;
    }

    if (method === 'GET' && (pathname === '/ca.der' || pathname === '/ca.cer')) {
        send('200 OK', [
            'Content-Type: application/pkix-cert',
            'Content-Disposition: attachment; filename="qqfarm-ca.cer"',
        ], fs.readFileSync(certs.caDer));
        return;
    }

    if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        send('200 OK', ['Content-Type: text/html; charset=utf-8'], Buffer.from(guidePage(PORT), 'utf8'));
        return;
    }

    // 其余明文请求按绝对 URL 或 Host 头转发
    let host = absolute ? absolute.hostname : hostHeader.split(':')[0];
    let port = absolute ? Number(absolute.port) || 80 : Number(hostHeader.split(':')[1]) || 80;
    let urlPath = absolute ? absolute.pathname + absolute.search : pathname;
    if (!host) { socket.destroy(); return; }

    record(`http://${host}${urlPath}`, host);

    const upstream = net.connect({ host, port });
    upstream.once('connect', () => {
        upstream.write(head);
        if (rest && rest.length) upstream.write(rest);
        socket.pipe(upstream);
        upstream.pipe(socket);
    });
    const kill = () => { socket.destroy(); upstream.destroy(); };
    upstream.on('error', kill);
    socket.on('error', kill);
}

/* ------------------------------------------------------------------ 主流程 */

function main() {
    const certs = ensureCerts();
    if (fs.existsSync(LOG_FILE)) fs.appendFileSync(LOG_FILE, `\n=== 新会话 ${new Date().toISOString()} ===\n`);

    const server = net.createServer((socket) => {
        socket.once('data', (chunk) => {
            const text = chunk.toString('latin1');
            const endOfHead = text.indexOf('\r\n\r\n');
            const head = endOfHead >= 0 ? chunk.subarray(0, endOfHead + 4) : chunk;
            const rest = endOfHead >= 0 ? chunk.subarray(endOfHead + 4) : Buffer.alloc(0);
            const firstLine = text.split('\r\n')[0] || '';
            const connect = /^CONNECT (\S+):(\d+) HTTP\/1\.[01]/i.exec(firstLine);

            if (connect) {
                const host = connect[1];
                const port = Number(connect[2]);
                // 先记 CONNECT，再决定解密还是裸隧道。
                // 这样即使 TLS 握手失败（客户端不信任我们的 CA），也能证明流量确实经过了代理。
                record(`CONNECT ${host}:${port}`, host, 'connect');
                if (shouldMitm(host)) mitm(socket, host, port, certs);
                else tunnel(socket, host, port, rest);
                return;
            }
            handlePlain(socket, head, rest, certs);
        });
        socket.on('error', () => socket.destroy());
    });

    server.on('error', (error) => {
        console.error(`[代理] 启动失败: ${error.message}`);
        if (error.code === 'EADDRINUSE') console.error(`       端口 ${PORT} 被占用，换一个: --port 18001`);
        process.exit(1);
    });

    server.listen(PORT, '0.0.0.0', () => {
        const ips = localAddresses();
        console.log('');
        console.log('================ QQ 农场资源嗅探代理 ================');
        console.log(`  监听端口   : ${PORT}`);
        console.log(`  内网地址   : ${ips.length ? ips.map(ip => `${ip}:${PORT}`).join('  ') : '未检测到'}`);
        console.log(`  CA 证书    : http://${ips[0] || '127.0.0.1'}:${PORT}/ca.crt`);
        console.log(`  说明页     : http://${ips[0] || '127.0.0.1'}:${PORT}/`);
        console.log(`  日志        : ${LOG_FILE}`);
        console.log('----------------------------------------------------');
        console.log('  1) 手机连同一 WiFi，WiFi 设置里手动代理指向上面的内网地址');
        console.log('  2) 手机浏览器打开 CA 证书地址，下载并安装/信任');
        console.log(`  3) 【自检】手机浏览器打开下面的官方 CDN 地址：`);
        console.log(`     https://cdn-resource.nqf.qq.com/release/remote/extraRes/config.c384c.json`);
        console.log(`     这里出现 [资源] 行 = https 解密成功，可以继续；只有 [隧道] 行 = CA 没被信任。`);
        console.log('  4) 打开 QQ → 农场，玩到能看到红薯地块，停留 30 秒');
        console.log('  5) 回到这里按 Ctrl+C 结束，把日志交给助手分析');
        console.log('----------------------------------------------------');
        console.log('  日志标记：ASSET=资源 URL  CONN=经过代理的域名  REQ=其他请求');
        console.log('====================================================');
        console.log('');
    });

    process.on('SIGINT', () => {
        console.log(`\n[完成] 共记录 ${seen.size} 条 URL（隧道 ${connectCount} / 资源 ${assetCount}）。`);
        console.log(`       日志: ${LOG_FILE}`);
        process.exit(0);
    });
}

try {
    main();
} catch (error) {
    console.error(`启动失败: ${error.message}`);
    process.exit(1);
}
