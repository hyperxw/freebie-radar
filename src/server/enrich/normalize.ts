const TRACKING_PARAMS = new Set([
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "utm_id",
  "spm", "scm", "from", "from_source", "share_source", "share_medium", "share_plat",
  "share_session_id", "share_tag", "timestamp", "ref", "referrer", "fbclid", "gclid",
  "yclid", "igshid", "mc_cid", "mc_eid", "s_cid", "sr_share", "isappinstalled",
  "appuid", "apptime", "share_from_user_hidden", "xsec_source", "xsec_token",
]);

/** 去掉追踪参数、片段、末尾斜杠，统一 host 大小写；保留有意义的 query。 */
export function normalizeUrl(input: string, base?: string): string {
  const raw = (input ?? "").trim();
  if (!raw) return "";
  let u: URL;
  try {
    u = new URL(raw, base);
  } catch {
    return raw;
  }
  u.hash = "";
  u.hostname = u.hostname.toLowerCase();
  const keep: [string, string][] = [];
  for (const [k, v] of u.searchParams.entries()) {
    if (TRACKING_PARAMS.has(k.toLowerCase())) continue;
    if (/^(utm_|spm|share_)/i.test(k)) continue;
    keep.push([k, v]);
  }
  keep.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  u.search = "";
  for (const [k, v] of keep) u.searchParams.append(k, v);
  if (u.pathname.length > 1 && u.pathname.endsWith("/")) u.pathname = u.pathname.replace(/\/+$/, "");
  return u.toString();
}

/** 去重键：同一资源在不同参数下应产生同一个 key。 */
export function urlKey(input: string, base?: string): string {
  const normalized = normalizeUrl(input, base);
  try {
    const u = new URL(normalized);
    return `${u.hostname}${u.pathname}${u.search}`.toLowerCase();
  } catch {
    return normalized.toLowerCase();
  }
}

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'",
};

export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&([a-z]+|#39);/gi, (m, name: string) => ENTITIES[name] ?? m);
}

/** 粗暴但够用的 HTML → 纯文本。 */
export function cleanText(input: string | null | undefined, maxLength = 400): string {
  if (!input) return "";
  const text = decodeEntities(
    String(input)
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<\/p>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " "),
  ).trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

export function parseDate(input: string | number | null | undefined): string | null {
  if (input === null || input === undefined || input === "") return null;
  if (typeof input === "number") {
    const ms = input > 1e12 ? input : input * 1000;
    return new Date(ms).toISOString();
  }
  const s = input.trim();
  if (/^\d{10}$/.test(s)) return new Date(Number(s) * 1000).toISOString();
  if (/^\d{13}$/.test(s)) return new Date(Number(s)).toISOString();
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const XHS_NOTE_ID_RE = /xiaohongshu\.com\/(?:explore|search_result|discovery\/item)\/([0-9a-f]{24})(?:$|[/?#])/i;
const MIN_XHS_TS_SEC = 1_420_070_400; // 2015-01-01T00:00:00Z

/** 从小红书 24 位十六进制笔记 ID 前 8 位解码秒级创建时间，作发布时间兜底。 */
export function xhsPublishedAtFromUrl(url: string, nowMs = Date.now()): string | null {
  const m = XHS_NOTE_ID_RE.exec(url);
  if (!m) return null;
  const sec = Number.parseInt(m[1]!.slice(0, 8), 16);
  if (!Number.isFinite(sec) || sec < MIN_XHS_TS_SEC) return null;
  const ms = sec * 1000;
  if (ms > nowMs + 86_400_000) return null;
  return new Date(ms).toISOString();
}

function buildEndDate(year: number, month: number, day: number, zeroHour = false): Date | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = zeroHour
    ? new Date(year, month - 1, day, 0, 0, 0)
    : new Date(year, month - 1, day, 23, 59, 59);
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return null;
  return d;
}

function resolveExpiryDate(
  month: number,
  day: number,
  explicitYear: number | undefined,
  refMs: number,
  zeroHour = false,
  pastStatedYear?: number,
): Date | null {
  const year = explicitYear ?? pastStatedYear;
  if (year !== undefined) {
    return buildEndDate(year, month, day, zeroHour);
  }
  const refYear = new Date(refMs).getFullYear();
  const d = buildEndDate(refYear, month, day, zeroHour);
  if (!d) return null;
  // 仅当写明的月日比参考时间早超过半年（如 12 月发帖写 1 月截止）才顺延到下一年，
  // 避免把刚过期几天的「11.22」误判成明年。
  if (d.getTime() < refMs - 180 * 86_400_000) {
    return buildEndDate(refYear + 1, month, day, zeroHour);
  }
  return d;
}

/** 规范化 AI 返回的截止日期（支持 YYYY-MM-DD 按当天 23:59:59 算或完整 ISO）。 */
export function parseAiExpiry(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s) return null;
  const ymd = /^(20\d{2})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (ymd) {
    const d = buildEndDate(Number(ymd[1]), Number(ymd[2]), Number(ymd[3]));
    return d ? d.toISOString() : null;
  }
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

const CN_RANGE_RE =
  /(?:(20\d{2})\s*[年./-]\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?\s*(?:[-~～至到]|——)\s*(?:(20\d{2})\s*[年./-]\s*)?(?:(\d{1,2})\s*月\s*)?(\d{1,2})\s*[日号]?(?!\s*[亿万元块刀%折倍])/;
const NUM_RANGE_RE =
  /(?<![\d.vV])(?:(20\d{2})\s*([./-])\s*)?(\d{1,2})\s*([./-])\s*(\d{1,2})\s*([-~～至到]|——)\s*(?:(20\d{2})\s*[./-]\s*)?(?:(\d{1,2})\s*[./-]\s*)?(\d{1,2})(?![\d.])(?!\s*[亿万元块刀%折倍])/;
const EXPIRY_BEFORE_RE =
  /(?:截止|截至|到期|结束|过期|有效期(?:至|到)?|有效至|活动(?:时间)?至|\bends?\b|\buntil\b|\bexpires?\b|\bvalid\s*(?:thru|through|until))\s*(?:时间|日期|于)?\s*[：:为到至]?\s*(?:(20\d{2})\s*[-./年]\s*)?(\d{1,2})\s*(?:[-./月])\s*(\d{1,2})\s*[日号]?(?![\d.])(?!\s*[亿万元块刀%折倍])/i;
const EXPIRY_AFTER_RE =
  /(?<![\d.])(?:(20\d{2})\s*[-./年]\s*)?(\d{1,2})\s*(?:[-./月])\s*(\d{1,2})\s*[日号]?(?!\s*[亿万元块刀%折倍])\s*(?:晚\s*)?(?:([0零]点)|(?:\d{1,2}\s*[:：]\s*\d{2}|\d{1,2}\s*点))?\s*(?:前|之前|以前|左右)?\s*(?:就|已|已经)?\s*(?:截止|截至|到期|结束|过期|有效|下线|停止|失效)/i;
const REL_EXPIRY_RE = /(\d+)\s*(天|日)\s*(?:内|后)?(?:有效|截止|过期)/;

/** 从文本里抽取「截止/有效期」类日期，结合发布时间推断年份与过期时刻。 */
export function guessExpiry(text: string, publishedAt?: string | null, nowMs = Date.now()): string | null {
  if (!text) return null;
  const pubRaw = publishedAt ? Date.parse(publishedAt) : Number.NaN;
  const pubMs = Number.isFinite(pubRaw) ? pubRaw : null;
  const refMs = pubMs ?? nowMs;
  // 若正文写了往年年份（如「2020 年的 7 月 13 日活动」），优先采用该往年年份
  const statedM = /(20\d{2})\s*年/.exec(text);
  const statedYear = statedM ? Number(statedM[1]) : undefined;
  const pastStatedYear =
    statedYear !== undefined && statedYear < new Date(refMs).getFullYear() ? statedYear : undefined;

  const before = EXPIRY_BEFORE_RE.exec(text);
  if (before) {
    const y = before[1] ? Number(before[1]) : undefined;
    const d = resolveExpiryDate(Number(before[2]), Number(before[3]), y, refMs, false, pastStatedYear);
    if (d) return d.toISOString();
  }

  const after = EXPIRY_AFTER_RE.exec(text);
  if (after) {
    const y = after[1] ? Number(after[1]) : undefined;
    const d = resolveExpiryDate(Number(after[2]), Number(after[3]), y, refMs, Boolean(after[4]), pastStatedYear);
    if (d) return d.toISOString();
  }

  const cnRange = CN_RANGE_RE.exec(text);
  if (cnRange) {
    const startOk = buildEndDate(Number(cnRange[1] ?? new Date(refMs).getFullYear()), Number(cnRange[2]), Number(cnRange[3]));
    if (startOk) {
      const y = cnRange[4] ? Number(cnRange[4]) : cnRange[1] ? Number(cnRange[1]) : undefined;
      const month = Number(cnRange[5] ?? cnRange[2]);
      const day = Number(cnRange[6]);
      if (cnRange[5] || day >= Number(cnRange[3])) {
        const d = resolveExpiryDate(month, day, y, refMs, false, pastStatedYear);
        if (d) return d.toISOString();
      }
    }
  }

  const numRange = NUM_RANGE_RE.exec(text);
  if (numRange) {
    const sep = numRange[4]!;
    const rangeSep = numRange[6]!;
    // 11-15-22 这类纯短横线容易与编号/电话混淆；日期用 - 时要求连接符为 ~ / ～ / 至 / 到 / ——
    const validRange = sep !== "-" || rangeSep !== "-";
    if (validRange) {
      const startOk = buildEndDate(Number(numRange[1] ?? new Date(refMs).getFullYear()), Number(numRange[3]), Number(numRange[5]));
      if (startOk) {
        const y = numRange[7] ? Number(numRange[7]) : numRange[1] ? Number(numRange[1]) : undefined;
        const month = Number(numRange[8] ?? numRange[3]);
        const day = Number(numRange[9]);
        if (numRange[8] || day >= Number(numRange[5])) {
          const d = resolveExpiryDate(month, day, y, refMs, false, pastStatedYear);
          if (d) return d.toISOString();
        }
      }
    }
  }

  const rel = REL_EXPIRY_RE.exec(text);
  if (rel) {
    const days = Number(rel[1]);
    if (Number.isFinite(days) && days > 0 && days <= 3650) {
      return new Date(refMs + days * 86_400_000).toISOString();
    }
  }
  return null;
}

const NOISE_IMG_RE = /(?:spacer|pixel|blank|1x1|tracking|beacon|gravatar\.com\/avatar|emoji|twemoji|\/avatars\/|user_avatar|badge|shields\.io|data:image)/i;

/** 校验并清洗封面图 URL：仅留合法 http(s) 地址，过滤追踪像素/头像/徽章等杂图。 */
export function sanitizeImageUrl(input: unknown, base?: string): string | null {
  if (typeof input !== "string") return null;
  let s = decodeEntities(input).trim();
  if (!s) return null;
  if (s.startsWith("//")) s = "https:" + s;
  if (NOISE_IMG_RE.test(s)) return null;
  try {
    const u = new URL(s, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    const full = u.toString();
    return full.length <= 600 ? full : null;
  } catch {
    return null;
  }
}

/** 从 HTML 片段里提取第一张有效内容图片 URL。 */
export function extractImageFromHtml(html: string | null | undefined, base?: string): string | null {
  if (!html) return null;
  const re = /<img\b[^>]*\b(?:src|data-src|data-original)\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const tag = m[0] ?? "";
    const widthM = /\bwidth\s*=\s*["']?(\d+)/i.exec(tag);
    const heightM = /\bheight\s*=\s*["']?(\d+)/i.exec(tag);
    if ((widthM && Number(widthM[1]) > 0 && Number(widthM[1]) < 32) || (heightM && Number(heightM[1]) > 0 && Number(heightM[1]) < 32)) {
      continue;
    }
    const clean = sanitizeImageUrl(m[1], base);
    if (clean) return clean;
  }
  return null;
}
