import assert from "node:assert/strict";
import { test } from "node:test";
import { cheapsharkCollector } from "../src/server/collectors/cheapshark.ts";

test("cheapsharkCollector 发送非浏览器应用 User-Agent 并正确解析免费与折扣游戏", async () => {
  const seenHeaders: Array<Record<string, string> | undefined> = [];
  const sampleDeals = [
    {
      dealID: "abc%3D",
      title: "Mark of the Deep",
      storeID: "25",
      gameID: "297257",
      salePrice: "0.00",
      normalPrice: "19.99",
      savings: "100.000000",
      steamRatingPercent: "71",
      steamAppID: "1933370",
    },
    {
      dealID: "xyz%3D",
      title: "Indie Bundle",
      storeID: "25",
      gameID: "326980",
      salePrice: "0.85",
      normalPrice: "9.99",
      savings: "91.49",
      steamAppID: null,
      thumb: "https://example.com/cover.png",
    },
  ];

  const fakeHttp = {
    raw: async () => {
      throw new Error("unused");
    },
    text: async () => {
      throw new Error("unused");
    },
    json: async <T,>(_url: string, opts?: { headers?: Record<string, string> }) => {
      seenHeaders.push(opts?.headers);
      return {
        status: 200,
        url: _url,
        data: sampleDeals as T,
        response: {
          status: 200,
          url: _url,
          headers: new Headers(),
          body: JSON.stringify(sampleDeals),
          bytes: Buffer.alloc(0),
          contentType: "application/json",
        },
      };
    },
  };

  const out = await cheapsharkCollector.collect({
    sourceId: "cheapshark-free",
    config: { upperPrice: 1, pageSize: 40 },
    cursor: null,
    maxItems: 40,
    http: fakeHttp,
    log: () => {},
  });

  const ua = seenHeaders[0]?.["user-agent"] ?? "";
  assert.match(ua, /FreebieRadar\//);
  assert.equal(/Mozilla\/5\.0/i.test(ua), false, "不能伪装 Chrome UA，避免触发 Cloudflare 403 质询");

  assert.equal(out.items.length, 2);
  assert.equal(out.items[0]?.url, "https://store.steampowered.com/app/1933370");
  assert.match(out.items[0]?.title ?? "", /^【免费领】 Mark of the Deep/);
  assert.equal(out.items[1]?.url, "https://www.cheapshark.com/redirect?dealID=xyz%253D");
  assert.match(out.items[1]?.title ?? "", /^【\$0\.85】 Indie Bundle/);
});
