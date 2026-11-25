import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { buildCurlArgs, createHttp } from "../src/server/http.ts";

test("buildCurlArgs 支持自定义 userAgent 且按大小写无关覆盖默认请求头", () => {
  const args = buildCurlArgs(
    "https://example.com/api",
    { headers: { "User-Agent": "OverrideUA/2.0", Accept: "application/json" } },
    10_000,
    "http://proxy:6152",
    "ClientUA/1.0",
  );

  const uaIdx = args.indexOf("-A");
  assert.notEqual(uaIdx, -1);
  assert.equal(args[uaIdx + 1], "OverrideUA/2.0");

  const headerFlags = args.flatMap((v, i) => (v === "-H" ? [args[i + 1] ?? ""] : []));
  assert.equal(
    headerFlags.some((h) => h.toLowerCase().startsWith("user-agent:")),
    false,
    "User-Agent 应通过 -A 传递而不重复拼 -H",
  );
  assert.deepEqual(
    headerFlags.filter((h) => h.toLowerCase().startsWith("accept:")),
    ["Accept: application/json"],
  );
  assert.equal(args[args.indexOf("-x") + 1], "http://proxy:6152");
});

test("buildCurlArgs 未覆盖时使用传入的 options.userAgent", () => {
  const args = buildCurlArgs("https://example.com/", {}, 5000, "", "CustomClient/1.0");
  assert.equal(args[args.indexOf("-A") + 1], "CustomClient/1.0");
});

test("createHttp.json 将单条 accept 与覆盖的 user-agent 真实发往服务端", async () => {
  const seen: Array<{ ua: string | string[] | undefined; accept: string | string[] | undefined }> = [];
  const server = http.createServer((req, res) => {
    seen.push({ ua: req.headers["user-agent"], accept: req.headers["accept"] });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  try {
    const addr = server.address();
    assert.ok(addr && typeof addr === "object");
    const url = `http://127.0.0.1:${addr.port}/test`;

    const client = createHttp({ gapMs: 0, userAgent: "ClientDefault/1.0" });
    await client.json(url);
    await client.json(url, { headers: { "user-agent": "PerReqUA/3.0", accept: "application/vnd.test+json" } });

    assert.equal(seen.length, 2);
    assert.equal(seen[0]?.ua, "ClientDefault/1.0");
    assert.equal(seen[0]?.accept, "application/json");
    assert.equal(seen[1]?.ua, "PerReqUA/3.0");
    assert.equal(seen[1]?.accept, "application/vnd.test+json");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
