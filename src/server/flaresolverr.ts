import { config } from "./config.ts";
import { decodeEntities } from "./enrich/normalize.ts";

export type FlareResult = { status: number; body: string; url: string };

const SESSION = "radar";
/** 空闲 90 秒后自动销毁 FlareSolverr 浏览器实例，避免 Chromium 长期常驻吃掉内存 */
const SESSION_IDLE_MS = 90_000;
/** 单次挑战最长等待上限，避免客户端超时断开后服务端继续卡死几分钟 */
const MAX_FLARE_TIMEOUT_MS = 45_000;
/** 触发熔断后的初始冷却与最大退避冷却时间 */
const BASE_COOLDOWN_MS = 180_000;
const MAX_COOLDOWN_MS = 900_000;

export class FlareUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FlareUnavailableError";
  }
}

function endpointOf(base: string): string {
  return /\/v\d+$/.test(base) ? base : base.replace(/\/+$/, "") + "/v1";
}

type FlarePayload = {
  status?: string;
  message?: string;
  solution?: { status?: number; url?: string; response?: string };
};

async function post(
  endpoint: string,
  body: Record<string, unknown>,
  timeoutMs = Math.min(config.flaresolverrTimeoutMs, MAX_FLARE_TIMEOUT_MS) + 15_000,
): Promise<FlarePayload> {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  try {
    return JSON.parse(text) as FlarePayload;
  } catch {
    throw new Error(`FlareSolverr 返回非 JSON (${res.status}): ${text.slice(0, 160)}`);
  }
}

let sessionUp = false;
let lastSessionUse = 0;
let idleTimer: NodeJS.Timeout | null = null;
let consecutiveFailures = 0;
let circuitOpenUntil = 0;
let lockChain: Promise<unknown> = Promise.resolve();

/** 严格串行化所有 FlareSolverr 操作，防止并发拉起多个 Chromium 挤爆容器内存和 CPU */
function withFlareLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = lockChain.then(fn, fn);
  lockChain = next.catch(() => {});
  return next;
}

function clearIdleTimer(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function touchSessionIdle(endpoint: string): void {
  lastSessionUse = Date.now();
  clearIdleTimer();
  idleTimer = setTimeout(() => {
    idleTimer = null;
    void withFlareLock(async () => {
      if (sessionUp && Date.now() - lastSessionUse >= SESSION_IDLE_MS - 1000) {
        await dropSessionUnlocked(endpoint);
      }
    });
  }, SESSION_IDLE_MS);
  idleTimer.unref?.();
}

async function ensureSessionUnlocked(endpoint: string, timeoutMs: number): Promise<void> {
  if (sessionUp && Date.now() - lastSessionUse < 20 * 60_000) return;
  const created = await post(endpoint, { cmd: "sessions.create", session: SESSION }, timeoutMs);
  if (created.status !== "ok" && !/already exists/i.test(created.message ?? "")) {
    throw new Error(`创建 session 失败: ${created.message ?? created.status}`);
  }
  sessionUp = true;
  touchSessionIdle(endpoint);
}

async function dropSessionUnlocked(endpoint: string): Promise<void> {
  clearIdleTimer();
  sessionUp = false;
  try {
    await post(endpoint, { cmd: "sessions.destroy", session: SESSION }, 5_000);
  } catch {
    /* 销毁失败无所谓，下次会重建 */
  }
}

export async function releaseFlareSession(): Promise<void> {
  if (!sessionUp || !config.flaresolverrUrl) return;
  await withFlareLock(() => dropSessionUnlocked(endpointOf(config.flaresolverrUrl)));
}

async function requestUnlocked(endpoint: string, url: string, timeoutMs: number, session: string): Promise<FlareResult> {
  const effectiveTimeout = Math.max(5_000, Math.min(timeoutMs, MAX_FLARE_TIMEOUT_MS));
  const payloadBody: Record<string, unknown> = { cmd: "request.get", url, maxTimeout: effectiveTimeout, session };

  const payload = await post(endpoint, payloadBody, effectiveTimeout + 15_000);
  if (payload.status !== "ok" || !payload.solution) {
    throw new Error(
      `FlareSolverr 失败: ${payload.message ?? payload.status ?? "unknown"} (${JSON.stringify(payload).slice(0, 120)})`,
    );
  }
  const raw = String(payload.solution.response ?? "");
  const pre = /<pre[^>]*>([\s\S]*?)<\/pre>/i.exec(raw);
  touchSessionIdle(endpoint);
  return {
    status: payload.solution.status ?? 0,
    url: payload.solution.url ?? url,
    body: pre ? decodeEntities(pre[1]!) : raw,
  };
}

/** 仅当旧 session 丢失/过期且非浏览器启动崩溃时，才允许销毁后重建重试一次 */
function isRecoverableStaleSessionError(message: string): boolean {
  if (/not created|cannot connect|chrome|timeout|timed out|abort|fetch failed|ECONN/i.test(message)) {
    return false;
  }
  return /(?:session\b.*(?:not found|does not exist|invalid|expired)|invalid session)/i.test(message);
}

function recordFailureAndOpenCircuit(message: string): void {
  consecutiveFailures += 1;
  const severe =
    /timeout|timed out|abort|cannot connect|not created|fetch failed|ECONNREFUSED|ECONNRESET|返回非 JSON|500/i.test(
      message,
    );
  if (severe || consecutiveFailures >= 2) {
    const exponent = Math.max(0, consecutiveFailures - (severe ? 1 : 2));
    const cooldownMs = Math.min(BASE_COOLDOWN_MS * 2 ** exponent, MAX_COOLDOWN_MS);
    circuitOpenUntil = Date.now() + cooldownMs;
  }
}

/**
 * 通过 FlareSolverr 取页面。
 * 具备严格串行互斥、空闲 90 秒销毁、异常清理及失败熔断冷却，避免并发拉起多个 Chromium 拖垮主机。
 */
export async function flaresolverrGet(url: string, timeoutMs = config.flaresolverrTimeoutMs): Promise<FlareResult> {
  if (!config.flaresolverrUrl) throw new Error("FLARESOLVERR_URL 未配置，无法访问被 Cloudflare 保护的源");
  const endpoint = endpointOf(config.flaresolverrUrl);

  return withFlareLock(async () => {
    const now = Date.now();
    if (now < circuitOpenUntil) {
      const waitSec = Math.ceil((circuitOpenUntil - now) / 1000);
      throw new FlareUnavailableError(`FlareSolverr 熔断冷却中，约 ${waitSec} 秒后重试`);
    }

    clearIdleTimer();
    const effectiveTimeout = Math.max(5_000, Math.min(timeoutMs, MAX_FLARE_TIMEOUT_MS));

    try {
      await ensureSessionUnlocked(endpoint, effectiveTimeout + 15_000);
      const res = await requestUnlocked(endpoint, url, effectiveTimeout, SESSION);
      consecutiveFailures = 0;
      circuitOpenUntil = 0;
      return res;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await dropSessionUnlocked(endpoint);

      if (isRecoverableStaleSessionError(message)) {
        try {
          await ensureSessionUnlocked(endpoint, effectiveTimeout + 15_000);
          const res = await requestUnlocked(endpoint, url, effectiveTimeout, SESSION);
          consecutiveFailures = 0;
          circuitOpenUntil = 0;
          return res;
        } catch (retryErr) {
          const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
          await dropSessionUnlocked(endpoint);
          recordFailureAndOpenCircuit(retryMsg);
          throw retryErr;
        }
      }

      recordFailureAndOpenCircuit(message);
      throw err;
    }
  });
}

export function hasFlare(): boolean {
  return Boolean(config.flaresolverrUrl);
}

export const __flareInternals = {
  resetForTest(): void {
    clearIdleTimer();
    sessionUp = false;
    lastSessionUse = 0;
    consecutiveFailures = 0;
    circuitOpenUntil = 0;
    lockChain = Promise.resolve();
  },
  getState(): { sessionUp: boolean; consecutiveFailures: number; circuitOpenUntil: number } {
    return { sessionUp, consecutiveFailures, circuitOpenUntil };
  },
};
