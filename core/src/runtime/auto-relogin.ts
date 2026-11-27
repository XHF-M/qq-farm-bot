import { dropAccountBuffer, getAccountBuffer, hasAccountBuffer } from '../services/wx-login/buffer-store';
import { getNativeWxLoginCode } from '../services/wx-login/native-protocol';
import { WX_FARM_APP_ID } from '../services/wx-login/service';

/**
 * 掉线自动重登。
 *
 * 背景：农场登录用一次性 code 换会话，连接断了必须用新 code 重连。扫码时我们保存了
 * loginBuffer（见 wx-login/buffer-store），这里在掉线后用它在后台换一个新 code，
 * 更新账号并重启，做到「扫一次码，之后无人值守」。
 *
 * 关键策略：同账号别处登录（reasonCode=1）说明使用者正在手机上玩，
 * 立刻重登会把手机踢下线、双方互踢。所以这种情况用长冷却 + 指数退避，
 * 让位给人工操作；连接稳定满 10 分钟才把退避计数清零。
 */

type TimerHandle = unknown;

export interface AutoReloginScheduler {
    setTimeoutTask: (name: string, ms: number, fn: () => void) => TimerHandle;
    clear: (name: string) => void;
}

export interface AutoReloginDeps {
    scheduler: AutoReloginScheduler;
    log: (tag: string, message: string, extra?: any) => void;
    addAccountLog: (action: string, message: string, accountId?: string, accountName?: string, extra?: any) => void;
    getAccount: (accountId: string) => any | null;
    applyNewCode: (accountId: string, code: string) => any | null;
    startAccount: (account: any) => void | Promise<void>;
    isRunning: (accountId: string) => boolean;
    /** 进程正在退出时不再排新的重连任务 */
    isActive?: () => boolean;
}

export interface AutoReloginOptions {
    enabled: boolean;
    /** 被人工登录顶下线后的首次等待，默认 20 分钟 */
    baseDelayMs: number;
    maxDelayMs: number;
    maxAttempts: number;
    /** 连接持续在线多久算「稳定」，之后退避清零 */
    stableResetMs: number;
    /** code 过期 / 网关错误这类非人为掉线的首轮重试间隔 */
    fastRetryMs: number;
}

interface State {
    attempts: number;
    nextAt: number;
    stableTimer: boolean;
    givingUp: boolean;
    givenUpAt?: number;
}

const DEFAULT_BASE_DELAY_MIN = 20;
const MAX_DELAY_MS = 120 * 60_000;
const MAX_ATTEMPTS = 8;
const STABLE_RESET_MS = 10 * 60_000;
const FAST_RETRY_MS = 90_000;
/** 连续失败放弃后，多久才允许再次自动尝试 */
const GIVEUP_COOLDOWN_MS = 30 * 60_000;

export function resolveAutoReloginOptions(env: Record<string, string | undefined>): AutoReloginOptions {
    const flag = String(env.FARM_AUTO_RELOGIN || '').trim().toLowerCase();
    const baseMin = Number(env.FARM_AUTO_RELOGIN_DELAY_MIN);
    return {
        enabled: flag !== '0' && flag !== 'false' && flag !== 'off',
        baseDelayMs: (Number.isFinite(baseMin) && baseMin > 0 ? baseMin : DEFAULT_BASE_DELAY_MIN) * 60_000,
        maxDelayMs: MAX_DELAY_MS,
        maxAttempts: MAX_ATTEMPTS,
        stableResetMs: STABLE_RESET_MS,
        fastRetryMs: FAST_RETRY_MS,
    };
}

/** reasonCode=1 是「已在其他终端登录」，属于人工在别处上线 */
export function isOtherTerminalKick(reasonCode: number, reason: string): boolean {
    if (Number(reasonCode) === 1) return true;
    return /其他终端|another device|other terminal/i.test(String(reason || ''));
}

/**
 * loginBuffer 本身失效（票据过期 / 被作废）时重试再多次也没用，
 * 直接清掉凭据并要求重新扫码；网络类错误才值得退避重试。
 */
export function isLoginBufferExpired(message: string): boolean {
    return /ManualAuth rejected|invalid login buffer/i.test(String(message || ''));
}

export function createAutoRelogin(deps: AutoReloginDeps, options: AutoReloginOptions) {
    const states = new Map<string, State>();

    function timerName(accountId: string, kind: 'retry' | 'stable'): string {
        return `auto_relogin_${kind}_${accountId}`;
    }

    function accountName(accountId: string): string {
        const account = deps.getAccount(accountId);
        return String(account?.name || accountId);
    }

    function reset(accountId: string): void {
        const state = states.get(accountId);
        if (state?.stableTimer) deps.scheduler.clear(timerName(accountId, 'stable'));
        states.delete(accountId);
    }

    /** 连接恢复且稳定一段时间后清零退避，下次真掉线从最快档开始 */
    function markOnline(accountId: string): void {
        const state = states.get(accountId);
        if (!state || state.givingUp || state.stableTimer) return;
        state.stableTimer = true;
        deps.scheduler.setTimeoutTask(timerName(accountId, 'stable'), options.stableResetMs, () => {
            if (!states.has(accountId)) return;
            states.delete(accountId);
            deps.log('系统', `账号 ${accountName(accountId)} 已稳定在线，重置自动重登退避`, {
                accountId: String(accountId),
                accountName: accountName(accountId),
            });
        });
    }

    function schedule(accountId: string, delayMs: number, reason: string): void {
        const state = states.get(accountId);
        if (!state) return;
        state.nextAt = Date.now() + delayMs;
        deps.scheduler.clear(timerName(accountId, 'retry'));
        deps.scheduler.setTimeoutTask(timerName(accountId, 'retry'), delayMs, () => {
            void attempt(accountId, reason);
        });
        const minutes = Math.max(1, Math.round(delayMs / 60_000));
        deps.log('系统', `账号 ${accountName(accountId)} 将在约 ${minutes} 分钟后自动刷新 Code 重连`, {
            accountId: String(accountId),
            accountName: accountName(accountId),
            delayMs,
            attempts: state.attempts,
            reason,
        });
    }

    async function attempt(accountId: string, triggerReason: string): Promise<void> {
        const state = states.get(accountId);
        if (!state) return;
        if (deps.isActive && !deps.isActive()) {
            states.delete(accountId);
            return;
        }
        if (deps.isRunning(accountId)) {
            // 等待期间用户手动启动/其他路径已恢复，本次作废
            reset(accountId);
            return;
        }
        const record = getAccountBuffer(accountId);
        if (!record) {
            deps.addAccountLog('auto_relogin_skip', `账号 ${accountName(accountId)} 没有可复用的登录凭据，需手动重新扫码`, accountId, accountName(accountId), { reason: 'no_login_buffer' });
            reset(accountId);
            return;
        }

        deps.log('系统', `账号 ${accountName(accountId)} 自动刷新登录 Code（第 ${state.attempts} 次）`, {
            accountId: String(accountId),
            accountName: accountName(accountId),
            attempts: state.attempts,
            triggerReason,
        });

        try {
            const code = await getNativeWxLoginCode(record.buffer, WX_FARM_APP_ID);
            const account = deps.applyNewCode(accountId, code);
            if (!account) {
                reset(accountId);
                return;
            }
            await deps.startAccount(account);
            deps.addAccountLog('auto_relogin_ok', `账号 ${account.name || accountId} 已自动刷新 Code 并重新连接`, accountId, account.name || accountName(accountId), { attempts: state.attempts });
            deps.log('系统', `账号 ${accountName(accountId)} 自动重连已发起`, { accountId: String(accountId), accountName: accountName(accountId) });
        } catch (error: any) {
            const message = String(error?.message || error || 'unknown error');
            if (isLoginBufferExpired(message)) {
                // 凭据已废，重试只会白跑；清掉并等用户重新扫码
                dropAccountBuffer(accountId);
                deps.addAccountLog('auto_relogin_expired', `账号 ${accountName(accountId)} 登录凭据已失效（${message}），需要重新扫码登录`, accountId, accountName(accountId), { error: message });
                deps.log('错误', `账号 ${accountName(accountId)} 登录凭据已失效，请重新扫码: ${message}`, { accountId: String(accountId), accountName: accountName(accountId) });
                giveUp(accountId, message);
                return;
            }
            deps.addAccountLog('auto_relogin_fail', `账号 ${accountName(accountId)} 自动刷新 Code 失败：${message}`, accountId, accountName(accountId), { attempts: state.attempts, error: message });
            deps.log('错误', `账号 ${accountName(accountId)} 自动刷新 Code 失败: ${message}`, {
                accountId: String(accountId),
                accountName: accountName(accountId),
                attempts: state.attempts,
            });
            if (state.attempts >= options.maxAttempts) {
                giveUp(accountId, message);
                return;
            }
            state.attempts += 1;
            // 退避按「下一次是第几次」算：第 2 次等 2×base，第 3 次 4×base……
            const delay = Math.min(options.baseDelayMs * 2 ** Math.max(0, state.attempts - 1), options.maxDelayMs);
            schedule(accountId, delay, `retry:${message}`);
        }
    }

    function giveUp(accountId: string, reason: string): void {
        const state = states.get(accountId);
        if (!state) return;
        state.givingUp = true;
        state.givenUpAt = Date.now();
        deps.scheduler.clear(timerName(accountId, 'retry'));
        deps.addAccountLog('auto_relogin_giveup', `账号 ${accountName(accountId)} 连续 ${options.maxAttempts} 次自动重连失败，已停止尝试，请手动扫码`, accountId, accountName(accountId), { reason });
        deps.log('错误', `账号 ${accountName(accountId)} 自动重连放弃：连续 ${options.maxAttempts} 次失败，请手动更新 Code`, {
            accountId: String(accountId),
            accountName: accountName(accountId),
            reason,
        });
    }

    /** 放弃后的冷静期：期间即使再次检测到掉线也不再自动重连，避免无意义刷屏 */
    function isGivingUp(accountId: string): boolean {
        const state = states.get(accountId);
        if (!state?.givingUp) return false;
        if (Date.now() - Number(state.givenUpAt || 0) < GIVEUP_COOLDOWN_MS) return true;
        states.delete(accountId);
        return false;
    }

    /**
     * 掉线入口。reasonCode=1（其他终端登录）走长冷却，其他原因（code 过期、网关 400）快速重试。
     * 返回是否已接管（调用方可据此决定是否还要提示用户手动扫码）。
     */
    function notifyDisconnected(accountId: string, info: { reasonCode?: number; code?: number; reason?: string }): boolean {
        if (!options.enabled || !accountId) return false;
        if (deps.isActive && !deps.isActive()) return false;
        if (isGivingUp(accountId)) return false;
        if (!hasAccountBuffer(accountId)) {
            deps.log('系统', `账号 ${accountName(accountId)} 未保存可复用的登录凭据，需手动重新扫码`, { accountId: String(accountId), accountName: accountName(accountId) });
            return false;
        }
        const otherTerminal = isOtherTerminalKick(Number(info?.reasonCode) || 0, String(info?.reason || ''));
        const state = states.get(accountId) || { attempts: 0, nextAt: 0, stableTimer: false, givingUp: false };
        if (state.attempts >= options.maxAttempts) {
            giveUp(accountId, 'attempts exhausted');
            return false;
        }
        state.attempts += 1;
        state.stableTimer = false;
        states.set(accountId, state);
        const base = otherTerminal ? options.baseDelayMs : options.fastRetryMs;
        const delay = Math.min(base * 2 ** Math.max(0, state.attempts - 1), options.maxDelayMs);
        schedule(accountId, delay, otherTerminal ? 'other_terminal' : `disconnect_${info?.code || 0}`);
        return true;
    }

    return { notifyDisconnected, markOnline, reset };
}
