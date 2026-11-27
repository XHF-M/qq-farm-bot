import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const { ensureDataDir } = require('../../config/runtime-paths');

/**
 * 微信登录缓冲（loginBuffer）持久化。
 *
 * loginBuffer 是扫码后拿到的一次性登录票据，`getNativeWxLoginCode()` 可以用它
 * 反复换出新的 wx.login code。旧实现拿到 code 就把 session 销毁，断了只能重新扫码；
 * 这里把它按账号加密落盘，供掉线后自动换 code 重登。
 *
 * 目录结构（data 目录下）：
 *   .wx-login-buffer.key         AES-256-GCM 主密钥，0600
 *   wx-login-buffers/pending.json    code -> buffer 的临时映射（扫码完成到建账号之间）
 *   wx-login-buffers/<accountId>.json  账号绑定的 buffer
 */

const DIR_NAME = 'wx-login-buffers';
const KEY_FILE = '.wx-login-buffer.key';
const PENDING_FILE = 'pending.json';
/** 扫码拿到 code 到前端提交建账号，正常几十秒内完成，留 30 分钟余量 */
const PENDING_TTL_MS = 30 * 60 * 1000;
/** loginBuffer 真实 TTL 未知，超过这个时间的记录不再尝试 */
const MAX_BUFFER_AGE_MS = 30 * 24 * 60 * 60 * 1000;

interface Sealed {
    iv: string;
    tag: string;
    data: string;
}

interface PendingEntry extends Sealed {
    createdAt: number;
}

interface AccountBufferEntry extends Sealed {
    updatedAt: number;
}

export interface LoginBufferRecord {
    buffer: string;
    openid?: string;
    updatedAt: number;
}

function bufferDir(): string {
    const dir = path.join(ensureDataDir(), DIR_NAME);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
}

function keyFile(): string {
    return path.join(ensureDataDir(), KEY_FILE);
}

function loadKey(): Buffer {
    const file = keyFile();
    try {
        const raw = fs.readFileSync(file);
        if (raw.length === 32) return raw;
        // 文件被破坏时重建，已存的密文作废但不会让主流程崩
    } catch {
        // 首次运行
    }
    const key = crypto.randomBytes(32);
    fs.writeFileSync(file, key, { mode: 0o600 });
    return key;
}

function seal(plain: string): Sealed {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', loadKey(), iv);
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return {
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        data: data.toString('base64'),
    };
}

function unseal(sealed: Sealed): string {
    const decipher = crypto.createDecipheriv('aes-256-gcm', loadKey(), Buffer.from(sealed.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
    return Buffer.concat([
        decipher.update(Buffer.from(sealed.data, 'base64')),
        decipher.final(),
    ]).toString('utf8');
}

function readJson<T>(file: string, fallback: T): T {
    try {
        const raw = fs.readFileSync(file, 'utf8');
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed as T : fallback;
    } catch {
        return fallback;
    }
}

function writeJson(file: string, value: unknown): void {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(tmp, file);
}

function pendingFile(): string {
    return path.join(bufferDir(), PENDING_FILE);
}

function accountFile(accountId: string): string {
    const safe = String(accountId || '').replace(/[^\w.-]/g, '_');
    return path.join(bufferDir(), `${safe}.json`);
}

function readPending(): Record<string, PendingEntry> {
    const all = readJson<Record<string, PendingEntry>>(pendingFile(), {});
    const now = Date.now();
    const fresh: Record<string, PendingEntry> = {};
    let dropped = 0;
    for (const [key, entry] of Object.entries(all)) {
        if (!entry || typeof entry.createdAt !== 'number' || now - entry.createdAt > PENDING_TTL_MS) {
            dropped += 1;
            continue;
        }
        fresh[key] = entry;
    }
    if (dropped > 0) writeJson(pendingFile(), fresh);
    return fresh;
}

/** loginBuffer 只对同一个 code 有意义，用 code 的哈希做键，避免按明文索引 */
export function codeKey(code: string): string {
    return crypto.createHash('sha256').update(String(code || '')).digest('hex');
}

/** 扫码换出 code 后调用，供建账号时认领。buffer / openid / nickname 一起加密。 */
export function rememberPendingBuffer(code: string, info: { buffer: string; openid?: string; nickname?: string }): void {
    if (!code || !info?.buffer) return;
    const pending = readPending();
    const payload = JSON.stringify({
        buffer: info.buffer,
        openid: info.openid || '',
        nickname: info.nickname || '',
    });
    pending[codeKey(code)] = { ...seal(payload), createdAt: Date.now() };
    writeJson(pendingFile(), pending);
}

/**
 * 账号写入 code 时调用：把 pending 里的 buffer 绑到 accountId。
 * 手工粘贴 code（没有扫码记录）时返回 false，该账号只能手动重登。
 */
export function bindPendingBufferToAccount(code: string, accountId: string): boolean {
    if (!code || !accountId) return false;
    const pending = readPending();
    const key = codeKey(code);
    const entry = pending[key];
    if (!entry) return false;
    try {
        writeJson(accountFile(accountId), { iv: entry.iv, tag: entry.tag, data: entry.data, updatedAt: Date.now() });
    } catch {
        return false;
    }
    delete pending[key];
    writeJson(pendingFile(), pending);
    return true;
}

export function getAccountBuffer(accountId: string): LoginBufferRecord | null {
    if (!accountId) return null;
    const entry = readJson<AccountBufferEntry | null>(accountFile(accountId), null);
    if (!entry || !entry.iv || !entry.tag || !entry.data) return null;
    if (typeof entry.updatedAt !== 'number' || Date.now() - entry.updatedAt > MAX_BUFFER_AGE_MS) return null;
    try {
        const payload = JSON.parse(unseal(entry)) as { buffer?: string; openid?: string };
        if (!payload?.buffer) return null;
        return { buffer: String(payload.buffer), openid: String(payload.openid || ''), updatedAt: entry.updatedAt };
    } catch {
        return null;
    }
}

export function hasAccountBuffer(accountId: string): boolean {
    return !!getAccountBuffer(accountId);
}

export function dropAccountBuffer(accountId: string): void {
    if (!accountId) return;
    try {
        fs.unlinkSync(accountFile(accountId));
    } catch {
        // 文件不存在即目标状态
    }
}
