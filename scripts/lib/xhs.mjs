export const XHS_CHATTER_RE =
  /^(?:怎么看待|如何评价|怎样做才|为什么|为何|男生|女生|请问|有人知道)|被白嫖|白嫖怪|相亲|考研|骑手|求推荐|求一个|求个|求购/;

const XHS_NOTE_ID_RE = /(?:explore|search_result|discovery\/item)\/([0-9a-f]{24})(?:$|[/?#])/i;
const MIN_XHS_TS_SEC = 1_420_070_400; // 2015-01-01T00:00:00Z
const DAY_MS = 86_400_000;

export function cleanXhsText(text, limit = 3500) {
  const cleaned = (text || "").replace(/\s+/g, " ").trim();
  if (!cleaned || cleaned === "还没有简介") return "";
  return cleaned.slice(0, limit);
}

/** 从小红书 24 位十六进制笔记 ID 前 8 位解码创建时间，作发布时间兜底。 */
export function xhsPublishedAtFromUrl(url, nowMs = Date.now()) {
  const m = XHS_NOTE_ID_RE.exec(String(url || ""));
  if (!m) return null;
  const sec = Number.parseInt(m[1].slice(0, 8), 16);
  if (!Number.isFinite(sec) || sec < MIN_XHS_TS_SEC) return null;
  const ms = sec * 1000;
  if (ms > nowMs + DAY_MS) return null;
  return new Date(ms).toISOString();
}

/** 解析小红书搜索列表常见中文相对/短日期（如「3天前」「昨天 12:30」「11-16」「2026-11-16」）。 */
export function parseXhsRelativeTime(text, nowMs = Date.now()) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  if (!s) return null;
  if (/刚刚/.test(s)) return new Date(nowMs).toISOString();

  const minM = /(\d+)\s*分钟前/.exec(s);
  if (minM) return new Date(nowMs - Number(minM[1]) * 60_000).toISOString();

  const hrM = /(\d+)\s*小时前/.exec(s);
  if (hrM) return new Date(nowMs - Number(hrM[1]) * 3_600_000).toISOString();

  const dayM = /(\d+)\s*天前/.exec(s);
  if (dayM) return new Date(nowMs - Number(dayM[1]) * DAY_MS).toISOString();

  const relDay = /^(今天|昨天|前天)(?:\s*(\d{1,2}):(\d{2}))?/.exec(s);
  if (relDay) {
    const offset = relDay[1] === "今天" ? 0 : relDay[1] === "昨天" ? 1 : 2;
    const d = new Date(nowMs - offset * DAY_MS);
    if (relDay[2] !== undefined && relDay[3] !== undefined) {
      d.setHours(Number(relDay[2]), Number(relDay[3]), 0, 0);
    }
    return d.toISOString();
  }

  const fullDate = /^(20\d{2})[-./](\d{1,2})[-./](\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?$/.exec(s);
  if (fullDate) {
    const y = Number(fullDate[1]);
    const mo = Number(fullDate[2]);
    const da = Number(fullDate[3]);
    const hh = fullDate[4] ? Number(fullDate[4]) : 12;
    const mm = fullDate[5] ? Number(fullDate[5]) : 0;
    const d = new Date(y, mo - 1, da, hh, mm, 0);
    if (d.getFullYear() === y && d.getMonth() === mo - 1 && d.getDate() === da) {
      return d.toISOString();
    }
    return null;
  }

  const shortDate = /^(\d{1,2})[-./](\d{1,2})$/.exec(s);
  if (shortDate) {
    const nowDate = new Date(nowMs);
    let y = nowDate.getFullYear();
    const mo = Number(shortDate[1]);
    const da = Number(shortDate[2]);
    let d = new Date(y, mo - 1, da, 12, 0, 0);
    if (d.getMonth() !== mo - 1 || d.getDate() !== da) return null;
    if (d.getTime() > nowMs + DAY_MS) {
      y -= 1;
      d = new Date(y, mo - 1, da, 12, 0, 0);
    }
    return d.toISOString();
  }
  return null;
}

/** 从小红书单条笔记 SSR HTML 提取正文 desc 与毫秒/秒级发布时间戳（两者独立提取，纯图帖也不丢时间）。 */
export function extractXhsDetailFromHtml(html, nowMs = Date.now()) {
  const raw = String(html || "");
  if (!raw) return { desc: "", publishedAt: null };

  const idx = raw.indexOf('"noteDetailMap"');
  const scope = idx >= 0 ? raw.slice(idx) : raw;

  const dMatch = scope.match(/"desc":"((?:\\.|[^"])*)"/) || raw.match(/"desc":"((?:\\.|[^"])*)"/);
  let desc = "";
  if (dMatch) {
    try {
      desc = JSON.parse('"' + dMatch[1] + '"');
    } catch {
      desc = dMatch[1];
    }
  }
  if (!desc) {
    const meta =
      raw.match(/<meta\s+name="description"\s+content="([^"]*)"/i) ||
      raw.match(/<meta\s+content="([^"]*)"\s+name="description"/i);
    if (meta) desc = meta[1];
  }
  desc = cleanXhsText(desc, 3500);

  let publishedAt = null;
  const tRe = /"time":(\d{10,13})/g;
  let tm;
  while ((tm = tRe.exec(scope)) !== null) {
    const n = Number(tm[1]);
    if (!Number.isFinite(n) || n <= 0) continue;
    const ms = n > 1e12 ? n : n * 1000;
    const sec = ms / 1000;
    if (sec >= MIN_XHS_TS_SEC && ms <= nowMs + DAY_MS) {
      publishedAt = new Date(ms).toISOString();
      break;
    }
  }
  return { desc, publishedAt };
}

/** 从小红书搜索接口 JSON（/api/sns/web/v1/search/notes）提取列表条目与发布时间。 */
export function extractXhsSearchNotesFromJson(jsonText, nowMs = Date.now()) {
  const out = [];
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return out;
  }
  const items = parsed?.data?.items;
  if (!Array.isArray(items)) return out;
  for (const it of items) {
    const id = String(it?.id || "").trim();
    const card = it?.note_card;
    if (!id || !card || typeof card !== "object") continue;
    const url = `https://www.xiaohongshu.com/explore/${id}`;
    const xsec = String(it?.xsec_token || "").trim();
    const fetchUrl = xsec
      ? `https://www.xiaohongshu.com/explore/${id}?xsec_token=${encodeURIComponent(xsec)}&xsec_source=pc_search`
      : url;
    const title = String(card.display_title || card.title || "").trim();
    if (!title) continue;
    const author = String(card.user?.nickname || card.user?.nick_name || "").trim();
    const imageUrl = String(card.cover?.url_default || card.cover?.url_pre || "").trim();
    const tags = Array.isArray(card.corner_tag_info) ? card.corner_tag_info : [];
    const pubTag = tags.find((t) => t?.type === "publish_time")?.text;
    let publishedAt = parseXhsRelativeTime(pubTag, nowMs);
    let pubSource = publishedAt ? "search-api" : null;
    if (!publishedAt && typeof card.time === "number" && card.time > 0) {
      const ms = card.time > 1e12 ? card.time : card.time * 1000;
      if (ms / 1000 >= MIN_XHS_TS_SEC && ms <= nowMs + DAY_MS) {
        publishedAt = new Date(ms).toISOString();
        pubSource = "search-api";
      }
    }
    if (!publishedAt) {
      publishedAt = xhsPublishedAtFromUrl(url, nowMs);
      if (publishedAt) pubSource = "note-id";
    }
    out.push({ title, url, fetchUrl, author, imageUrl, publishedAt, pubSource });
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function trySortXhsNewest(page) {
  try {
    const newest = page.getByText("最新", { exact: true }).first();
    if (await newest.isVisible({ timeout: 1000 }).catch(() => false)) {
      await newest.click({ timeout: 1500 });
      await sleep(900);
      return true;
    }
    const filterBtn = page.getByText("筛选", { exact: true }).first();
    if (await filterBtn.isVisible({ timeout: 800 }).catch(() => false)) {
      await filterBtn.hover().catch(() => {});
      await filterBtn.click({ timeout: 1000 }).catch(() => {});
      await sleep(400);
      const newestAfter = page.getByText("最新", { exact: true }).first();
      if (await newestAfter.isVisible({ timeout: 1200 }).catch(() => false)) {
        await newestAfter.click({ timeout: 1500 });
        await sleep(900);
        return true;
      }
    }
  } catch {
    /* 排序按钮不可用时回退默认排序，后续按时间硬过滤 */
  }
  return false;
}

function isOlderThanDays(iso, maxDays, nowMs = Date.now()) {
  if (!iso) return false;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return false;
  return nowMs - ms > maxDays * DAY_MS;
}

/**
 * 采集小红书搜索结果并尽量补齐每条有效新帖的发布时间与正文：
 * 1. 搜索接口 JSON + DOM 卡片双路抓取
 * 2. 笔记 ID 前 8 位解码时间戳作保底
 * 3. 超龄旧帖先过滤再进详情队列，已入库条目跳过详情避免挤占新帖预算
 */
export async function collectXhsNotes(page, keywords, opts = {}) {
  const maxAgeDays = Math.max(Number(opts.maxAgeDays ?? 7) || 7, 1);
  const detailBudgetInit = Math.max(Number(opts.detailBudget ?? 24) || 24, 0);
  const knownSet = new Set(Array.isArray(opts.knownUrls) ? opts.knownUrls : []);
  const tag = opts.tag || "cookie-runner";
  const log = opts.log || ((m) => console.log(m));
  const waitUntil = opts.waitUntil || "domcontentloaded";

  const seen = new Map();
  let detailBudget = detailBudgetInit;
  let lastErr = null;
  let detailFetched = 0;

  let apiNotes = [];
  const onResp = async (resp) => {
    try {
      if (resp.request().method() === "OPTIONS" || resp.status() !== 200) return;
      if (!resp.url().includes("/api/sns/web/v1/search/notes")) return;
      const txt = await resp.text().catch(() => "");
      if (txt) apiNotes.push(...extractXhsSearchNotesFromJson(txt));
    } catch {
      /* 忽略响应体已释放的情况 */
    }
  };
  page.on("response", onResp);

  try {
    for (const kw of keywords) {
      if (seen.size >= 60) break;
      apiNotes = [];
      const searchUrl =
        "https://www.xiaohongshu.com/search_result?keyword=" +
        encodeURIComponent(kw) +
        "&source=web_search_result_notes";
      try {
        await page.goto(searchUrl, { waitUntil, timeout: 25_000 });
        for (let i = 0; i < 20; i++) {
          const count = await page.locator("section.note-item").count();
          if (count > 0) break;
          await sleep(450);
        }
        await sleep(700);
      } catch (err) {
        lastErr = err;
        continue;
      }

      const prevApiNotes = apiNotes;
      apiNotes = [];
      const sortedNewest = await trySortXhsNewest(page);
      if (!sortedNewest || !apiNotes.length) apiNotes = prevApiNotes;

      await page.mouse.wheel(0, 1600);
      await sleep(700);

      const state = await page.evaluate(() => {
        const text = document.body?.innerText || "";
        const needLogin = /登录后查看搜索结果|扫码登录|手机号登录/.test(text);
        const items = Array.from(document.querySelectorAll("section.note-item"))
          .map((c) => {
            const a =
              c.querySelector("a.cover") ||
              c.querySelector('a[href*="/search_result/"]') ||
              c.querySelector('a[href*="/explore/"]');
            const t = c.querySelector(".title span, .footer .title, .title");
            const au = c.querySelector(".author .name, .name");
            const img = c.querySelector("img");
            const rawHref = (a && a.href) || "";
            const m = rawHref.match(/\/(?:explore|search_result)\/([0-9a-zA-Z]+)/);
            const canonical = m ? `https://www.xiaohongshu.com/explore/${m[1]}` : rawHref;
            return {
              title: ((t && t.textContent) || "").trim(),
              url: canonical,
              fetchUrl: rawHref,
              author: ((au && au.textContent) || "").trim(),
              imageUrl: img ? img.getAttribute("src") || "" : "",
            };
          })
          .filter((x) => x.title && x.url);
        return { needLogin, items };
      });

      if (state.needLogin && !state.items.length && !apiNotes.length) {
        throw new Error("小红书 Cookie 已失效或被跳转验证");
      }

      const apiByUrl = new Map(apiNotes.map((n) => [n.url, n]));
      const merged = [];
      for (const it of state.items) {
        const fromApi = apiByUrl.get(it.url);
        merged.push({
          ...it,
          fetchUrl: it.fetchUrl || fromApi?.fetchUrl || it.url,
          author: it.author || fromApi?.author || "",
          imageUrl: it.imageUrl || fromApi?.imageUrl || "",
          publishedAt: fromApi?.publishedAt || xhsPublishedAtFromUrl(it.url),
          pubSource: fromApi?.pubSource || (xhsPublishedAtFromUrl(it.url) ? "note-id" : null),
        });
      }
      for (const n of apiNotes) {
        if (!merged.some((x) => x.url === n.url)) merged.push(n);
      }

      const nowMs = Date.now();
      const detailTargets = [];
      for (const it of merged) {
        // ID 时间是草稿创建时间（少数草稿 1-3 天后才发出），初筛给 +3 天缓冲，详情页拿到精确 time 后再严卡
        const preLimit = it.pubSource === "note-id" ? maxAgeDays + 3 : maxAgeDays;
        if (isOlderThanDays(it.publishedAt, preLimit, nowMs)) {
          if (!seen.has(it.url)) seen.set(it.url, { ...it, stalePreFiltered: true });
          continue;
        }
        if (!seen.has(it.url)) seen.set(it.url, it);
        const cur = seen.get(it.url);
        if (
          detailBudget > 0 &&
          !cur.detailChecked &&
          !knownSet.has(it.url) &&
          !XHS_CHATTER_RE.test(it.title) &&
          it.fetchUrl
        ) {
          cur.detailChecked = true;
          detailTargets.push({ url: it.url, fetchUrl: it.fetchUrl });
          detailBudget -= 1;
        }
      }

      for (let i = 0; i < detailTargets.length; i += 4) {
        const batch = detailTargets.slice(i, i + 4);
        try {
          const htmlMap = await page.evaluate(async (targets) => {
            const out = {};
            await Promise.all(
              targets.map(async ({ url, fetchUrl }) => {
                try {
                  const r = await fetch(fetchUrl, {
                    credentials: "include",
                    signal: AbortSignal.timeout(8000),
                  });
                  if (!r.ok) return;
                  const html = await r.text();
                  const idx = html.indexOf('"noteDetailMap"');
                  const scope = idx >= 0 ? html.slice(Math.max(0, idx - 200), idx + 80_000) : html.slice(0, 80_000);
                  const meta = html.match(/<meta\s+(?:name="description"\s+content="([^"]*)"|content="([^"]*)"\s+name="description")/i);
                  const metaTag = meta ? `<meta name="description" content="${meta[1] || meta[2] || ""}">` : "";
                  out[url] = metaTag ? `${metaTag}\n${scope}` : scope;
                } catch {
                  /* 单篇拉取失败保留兜底时间 */
                }
              }),
            );
            return out;
          }, batch);

          for (const [u, snippet] of Object.entries(htmlMap || {})) {
            const cur = seen.get(u);
            if (!cur) continue;
            const detail = extractXhsDetailFromHtml(snippet);
            detailFetched += 1;
            if (detail.desc) {
              cur.content = detail.desc;
              cur.summary = cleanXhsText(detail.desc, 380);
            }
            if (detail.publishedAt) {
              cur.publishedAt = detail.publishedAt;
              cur.pubSource = "ssr-detail";
            }
          }
        } catch {
          /* 批次拉取失败继续 */
        }
        if (i + 4 < detailTargets.length) await sleep(250);
      }
    }
  } finally {
    page.off("response", onResp);
  }

  if (seen.size === 0 && lastErr) throw lastErr;

  const nowMs = Date.now();
  const kept = [];
  let droppedStale = 0;
  for (const it of seen.values()) {
    if (it.stalePreFiltered || isOlderThanDays(it.publishedAt, maxAgeDays, nowMs)) {
      droppedStale += 1;
      continue;
    }
    kept.push({
      externalId: it.url,
      url: it.url,
      title: it.title,
      summary: it.summary || "",
      content: it.content || null,
      author: it.author || null,
      publishedAt: it.publishedAt || null,
      imageUrl: it.imageUrl || null,
      tags: ["xiaohongshu", tag],
    });
  }
  log(`[xhs] 扫描=${seen.size} 保留=${kept.length} 过滤超${maxAgeDays}天旧帖=${droppedStale} 补全详情=${detailFetched}`);
  return kept;
}
