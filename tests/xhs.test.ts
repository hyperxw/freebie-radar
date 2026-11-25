import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cleanXhsText,
  collectXhsNotes,
  extractXhsDetailFromHtml,
  extractXhsSearchNotesFromJson,
  parseXhsRelativeTime,
  xhsPublishedAtFromUrl,
} from "../scripts/lib/xhs.mjs";

function makeHexId(unixSec: number, suffix = "000000002a00d0d4"): string {
  return Math.floor(unixSec).toString(16).padStart(8, "0") + suffix;
}

test("小红书 URL 解码与相对时间解析", () => {
  const nowMs = Date.parse("2026-11-25T06:00:00Z");
  assert.equal(
    xhsPublishedAtFromUrl("https://www.xiaohongshu.com/explore/6afabad2000000002a00d0d4", nowMs),
    "2026-11-16T08:12:02.000Z",
  );
  assert.equal(cleanXhsText("还没有简介"), "");
  assert.equal(cleanXhsText("  正文内容  "), "正文内容");

  assert.equal(parseXhsRelativeTime("3天前", nowMs), new Date(nowMs - 3 * 86_400_000).toISOString());
  assert.equal(parseXhsRelativeTime("2小时前", nowMs), new Date(nowMs - 2 * 3_600_000).toISOString());
  const d16 = parseXhsRelativeTime("11-16", nowMs);
  assert.ok(d16);
  assert.equal(new Date(d16).getMonth(), 10);
  assert.equal(new Date(d16).getDate(), 16);
});

test("小红书详情 HTML 解析：纯图无简介时仍保留发布时间戳，过滤占位符", () => {
  const nowMs = Date.parse("2026-11-25T06:00:00Z");
  const tsMs = Date.parse("2026-11-24T10:00:00Z");
  const imgOnlyHtml = `<html><script>window.__INITIAL_STATE__={"note":{"noteDetailMap":{"x":{"note":{"desc":"还没有简介","time":${tsMs}}}}}}</script></html>`;
  const r1 = extractXhsDetailFromHtml(imgOnlyHtml, nowMs);
  assert.equal(r1.desc, "");
  assert.equal(r1.publishedAt, "2026-11-24T10:00:00.000Z");

  const fullHtml = `<html><script>window.__INITIAL_STATE__={"note":{"noteDetailMap":{"x":{"note":{"desc":"活动截止11月28日免费领","time":${tsMs}}}}}}</script></html>`;
  const r2 = extractXhsDetailFromHtml(fullHtml, nowMs);
  assert.equal(r2.desc, "活动截止11月28日免费领");
  assert.equal(r2.publishedAt, "2026-11-24T10:00:00.000Z");
});

test("小红书搜索 JSON 解析：提取 publish_time 与 xsec_token 详情链接", () => {
  const nowMs = Date.parse("2026-11-25T06:00:00Z");
  const id = makeHexId(Math.floor(Date.parse("2026-11-24T08:00:00Z") / 1000));
  const payload = JSON.stringify({
    data: {
      items: [
        {
          id,
          xsec_token: "tok123",
          note_card: {
            display_title: "免费领 AI Token",
            user: { nickname: "测试号" },
            corner_tag_info: [{ type: "publish_time", text: "1天前" }],
          },
        },
      ],
    },
  });
  const parsed = extractXhsSearchNotesFromJson(payload, nowMs);
  assert.equal(parsed.length, 1);
  assert.ok(parsed[0]);
  assert.equal(parsed[0].url, `https://www.xiaohongshu.com/explore/${id}`);
  assert.match(parsed[0].fetchUrl, /xsec_token=tok123/);
  assert.equal(parsed[0].publishedAt, new Date(nowMs - 86_400_000).toISOString());
});

test("collectXhsNotes：跳过已入库详情配额、过滤超龄旧帖并保留纯图帖时间", async () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const freshId1 = makeHexId(nowSec - 3600, "0000000000000001"); // 1h ago
  const freshId2 = makeHexId(nowSec - 7200, "0000000000000002"); // 2h ago (known)
  const freshImgId = makeHexId(nowSec - 10800, "0000000000000003"); // 3h ago (image only)
  const staleId = makeHexId(nowSec - 12 * 86400, "0000000000000004"); // 12d ago
  // Draft created 9d ago (within +3d pre-filter buffer) whose SSR publish time turns out 10d ago -> must be dropped
  const ssrStaleId = makeHexId(nowSec - 9 * 86400, "0000000000000005");

  const domItems = [
    {
      title: "已知老福利（已入库，不占详情预算）",
      url: `https://www.xiaohongshu.com/explore/${freshId2}`,
      fetchUrl: `https://www.xiaohongshu.com/explore/${freshId2}?xsec_token=k`,
      author: "A",
      imageUrl: "",
    },
    {
      title: "智谱再送1.5亿Token（12天前旧帖）",
      url: `https://www.xiaohongshu.com/explore/${staleId}`,
      fetchUrl: `https://www.xiaohongshu.com/explore/${staleId}?xsec_token=s`,
      author: "B",
      imageUrl: "",
    },
    {
      title: "最新AI免费额度福利",
      url: `https://www.xiaohongshu.com/explore/${freshId1}`,
      fetchUrl: `https://www.xiaohongshu.com/explore/${freshId1}?xsec_token=f1`,
      author: "C",
      imageUrl: "",
    },
    {
      title: "纯图福利（还没有简介也要拿时间）",
      url: `https://www.xiaohongshu.com/explore/${freshImgId}`,
      fetchUrl: `https://www.xiaohongshu.com/explore/${freshImgId}?xsec_token=f3`,
      author: "D",
      imageUrl: "",
    },
    {
      title: "详情里发现实际超过7天的帖子",
      url: `https://www.xiaohongshu.com/explore/${ssrStaleId}`,
      fetchUrl: `https://www.xiaohongshu.com/explore/${ssrStaleId}?xsec_token=f5`,
      author: "E",
      imageUrl: "",
    },
  ];

  const fetchedDetailUrls: string[] = [];
  const detailHtmlByUrl: Record<string, string> = {
    [`https://www.xiaohongshu.com/explore/${freshId1}?xsec_token=f1`]:
      `<html>"noteDetailMap":{"1":{"note":{"desc":"活动截止下月底免费领取","time":${(nowSec - 1800) * 1000}}}}</html>`,
    [`https://www.xiaohongshu.com/explore/${freshImgId}?xsec_token=f3`]:
      `<html>"noteDetailMap":{"3":{"note":{"desc":"还没有简介","time":${(nowSec - 5400) * 1000}}}}</html>`,
    [`https://www.xiaohongshu.com/explore/${ssrStaleId}?xsec_token=f5`]:
      `<html>"noteDetailMap":{"5":{"note":{"desc":"老活动","time":${(nowSec - 10 * 86400) * 1000}}}}</html>`,
  };

  const mockPage = {
    on() {},
    off() {},
    async goto() {},
    locator() {
      return { count: async () => domItems.length };
    },
    getByText() {
      return {
        first() {
          return {
            isVisible: async () => false,
            click: async () => {},
            hover: async () => {},
          };
        },
      };
    },
    mouse: { async wheel() {} },
    async evaluate(_fn: unknown, arg?: Array<{ url: string; fetchUrl: string }>) {
      if (!arg) return { needLogin: false, items: domItems };
      const out: Record<string, string> = {};
      for (const t of arg) {
        fetchedDetailUrls.push(t.url);
        const raw = detailHtmlByUrl[t.fetchUrl] || "";
        const idx = raw.indexOf('"noteDetailMap"');
        out[t.url] = idx >= 0 ? raw.slice(idx) : raw;
      }
      return out;
    },
  };

  const items = await collectXhsNotes(mockPage, ["免费领取"], {
    maxAgeDays: 7,
    knownUrls: [`https://www.xiaohongshu.com/explore/${freshId2}`],
    log: () => {},
  });

  // 已知项与 12 天前旧帖都不应发详情请求
  assert.ok(!fetchedDetailUrls.includes(`https://www.xiaohongshu.com/explore/${freshId2}`));
  assert.ok(!fetchedDetailUrls.includes(`https://www.xiaohongshu.com/explore/${staleId}`));
  assert.equal(fetchedDetailUrls.length, 3);

  // 最终只保留 3 条 7 天内有效新帖（12天前、SSR 10天前全部过滤掉）
  const urls = items.map((x) => x.url);
  assert.equal(items.length, 3);
  assert.ok(urls.includes(`https://www.xiaohongshu.com/explore/${freshId1}`));
  assert.ok(urls.includes(`https://www.xiaohongshu.com/explore/${freshId2}`));
  assert.ok(urls.includes(`https://www.xiaohongshu.com/explore/${freshImgId}`));
  assert.ok(!urls.includes(`https://www.xiaohongshu.com/explore/${staleId}`));
  assert.ok(!urls.includes(`https://www.xiaohongshu.com/explore/${ssrStaleId}`));

  const imgItem = items.find((x) => x.url.includes(freshImgId));
  assert.ok(imgItem);
  assert.equal(imgItem.content, null);
  assert.equal(imgItem.publishedAt, new Date((nowSec - 5400) * 1000).toISOString());
});
