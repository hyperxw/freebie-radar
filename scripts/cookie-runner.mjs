import { createServer } from "node:http";
import { chromium } from "playwright";
import { existsSync } from "node:fs";
import { collectXhsNotes } from "./lib/xhs.mjs";

const PORT = Number(process.env.RUNNER_PORT || 18790);
const HOST = process.env.RUNNER_HOST || "0.0.0.0";
const CHROME_PATH = process.env.CHROME_EXECUTABLE || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

let busy = false;

function normalizeCookies(rawCookies, defaultDomain) {
  const out = [];
  for (const c of rawCookies || []) {
    if (!c || typeof c !== "object") continue;
    const name = String(c.name || "").trim();
    const value = String(c.value || "");
    const domain = String(c.domain || defaultDomain || "").trim();
    const path = String(c.path || "/").trim();
    if (!name || !value) continue;
    out.push({ name, value, domain, path });
  }
  return out;
}

async function collectXhs(page, keywords, opts = {}) {
  return collectXhsNotes(page, keywords, {
    ...opts,
    tag: "cookie-runner",
    log: (m) => console.log(`[cookie-runner] ${m}`),
  });
}

async function collectXiaoheihe(page, keywords) {
  const seen = new Map();
  const captured = [];
  const feedCaptured = [];

  const onResponse = async (resp) => {
    try {
      if (resp.request().method() === "OPTIONS" || resp.status() !== 200) return;
      const url = resp.url();
      if (url.includes("general/search")) {
        const text = await resp.text().catch(() => "");
        if (text) captured.push(text);
      } else if (url.includes("/bbs/app/feeds?")) {
        const text = await resp.text().catch(() => "");
        if (text) feedCaptured.push(text);
      }
    } catch {}
  };

  page.on("response", onResponse);

  try {
    for (const kw of keywords) {
      if (seen.size >= 40) break;
      captured.length = 0;
      await page.goto(`https://www.xiaoheihe.cn/app/bbs/home?t=${Date.now()}`, { waitUntil: "domcontentloaded", timeout: 30000 });
      await new Promise((r) => setTimeout(r, 2000));
      try {
        await page.fill(".el-input__inner", String(kw), { timeout: 8000 });
        await page.press(".el-input__inner", "Enter");
      } catch {
        continue;
      }

      for (let i = 0; i < 12; i++) {
        if (captured.length > 0) break;
        await new Promise((r) => setTimeout(r, 1000));
      }

      for (const txt of captured) {
        try {
          const parsed = JSON.parse(txt);
          const items = parsed?.result?.items || [];
          for (const it of items) {
            if (it?.type !== "link" || !it?.info) continue;
            const n = it.info;
            const linkid = String(n.linkid || "").trim();
            if (!linkid) continue;
            const title = String(n.title || "").replace(/<[^>]+>/g, "").trim();
            const summary = String(n.description || "").replace(/<[^>]+>/g, "").trim().slice(0, 300);
            const createdAt = n.create_at;
            let publishedAt = null;
            if (typeof createdAt === "number" && createdAt > 0) {
              const ms = createdAt > 1e12 ? createdAt : createdAt * 1000;
              publishedAt = new Date(ms).toISOString();
            }
            const topics = (n.topics || []).map((t) => t?.name).filter(Boolean);
            if (!seen.has(linkid)) {
              seen.set(linkid, {
                externalId: linkid,
                url: `https://www.xiaoheihe.cn/app/bbs/link/${linkid}`,
                title,
                summary,
                content: null,
                publishedAt,
                tags: ["xiaoheihe", ...topics.slice(0, 2)],
              });
            }
          }
        } catch {}
      }
    }
  } finally {
    page.off("response", onResponse);
  }

  if (seen.size === 0 && feedCaptured.length > 0) {
    for (const txt of feedCaptured) {
      try {
        const parsed = JSON.parse(txt);
        const links = parsed?.result?.links || [];
        for (const n of links) {
          if (!n || typeof n !== "object") continue;
          const linkid = String(n.linkid || "").trim();
          const title = String(n.title || "").replace(/<[^>]+>/g, "").trim();
          if (!linkid || !title || !/免费|白嫖|喜加一|限免|领取|福利|优惠/.test(title)) continue;
          const summary = String(n.description || "").replace(/<[^>]+>/g, "").trim().slice(0, 300);
          const createdAt = n.create_at;
          const publishedAt = typeof createdAt === "number" && createdAt > 0 ? new Date(createdAt > 1e12 ? createdAt : createdAt * 1000).toISOString() : null;
          if (!seen.has(linkid)) {
            seen.set(linkid, {
              externalId: linkid,
              url: `https://www.xiaoheihe.cn/app/bbs/link/${linkid}`,
              title,
              summary,
              content: null,
              publishedAt,
              tags: ["xiaoheihe"],
            });
          }
        }
      } catch {}
    }
  }

  if (seen.size === 0) {
    const needLogin = await page.evaluate(() => {
      const text = document.body?.innerText || "";
      return /登录\/注册/.test(text) && !document.querySelector(".user-info, .avatar, .el-avatar");
    }).catch(() => false);
    if (needLogin) {
      throw new Error("小黑盒 Cookie 已失效或未抓取到搜索响应");
    }
  }

  return [...seen.values()];
}

async function runCollect(site, rawCookies, keywords, proxyUrl, opts = {}) {
  const domainMap = { zhihu: ".zhihu.com", xhs: ".xiaohongshu.com", xiaoheihe: ".xiaoheihe.cn" };
  const cookies = normalizeCookies(rawCookies, domainMap[site] || "");
  if (!cookies.length) throw new Error("Cookie 为空");

  const launchOpts = {
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-blink-features=AutomationControlled",
    ],
  };

  if (existsSync(CHROME_PATH)) {
    launchOpts.executablePath = CHROME_PATH;
  }
  if (proxyUrl) {
    launchOpts.proxy = { server: proxyUrl };
  }

  const browser = await chromium.launch(launchOpts);
  try {
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 860 },
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    });
    await ctx.addCookies(cookies);
    const page = await ctx.newPage();
    page.setDefaultTimeout(35000);

    if (site === "xhs") {
      return await collectXhs(page, keywords, opts);
    }
    if (site === "xiaoheihe") {
      return await collectXiaoheihe(page, keywords);
    }
    throw new Error(`暂不支持的站点: ${site}`);
  } finally {
    await browser.close().catch(() => {});
  }
}

const server = createServer(async (req, res) => {
  const sendJson = (code, payload) => {
    const body = Buffer.from(JSON.stringify(payload));
    res.writeHead(code, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": body.length,
    });
    res.end(body);
  };

  const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);

  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(200, { ok: true, busy, chrome: existsSync(CHROME_PATH) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/collect") {
    if (busy) {
      sendJson(429, { ok: false, error: "runner busy" });
      return;
    }

    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", async () => {
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        sendJson(400, { ok: false, error: "invalid json" });
        return;
      }

      const site = String(body.site || "").trim();
      const keywords = Array.isArray(body.keywords) ? body.keywords : ["免费领取"];
      const cookies = Array.isArray(body.cookies) ? body.cookies : [];
      const proxy = String(body.proxy || "").trim();
      const maxAgeDays = Number(body.maxAgeDays) > 0 ? Number(body.maxAgeDays) : undefined;
      const knownUrls = Array.isArray(body.knownUrls) ? body.knownUrls : undefined;

      busy = true;
      try {
        console.log(`[cookie-runner] 开始采集 ${site}，关键词: ${keywords.join(", ")}`);
        const items = await runCollect(site, cookies, keywords, proxy, { maxAgeDays, knownUrls });
        console.log(`[cookie-runner] 采集完成，抓取到 ${items.length} 条条目`);
        sendJson(200, { ok: true, items });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[cookie-runner] 采集失败: ${msg}`);
        sendJson(200, { ok: false, needLogin: msg.includes("失效") || msg.includes("登录"), error: msg });
      } finally {
        busy = false;
      }
    });
    return;
  }

  sendJson(404, { ok: false, error: "not found" });
});

server.listen(PORT, HOST, () => {
  console.log(`[cookie-runner] listening on http://${HOST}:${PORT} (chrome: ${CHROME_PATH})`);
});
