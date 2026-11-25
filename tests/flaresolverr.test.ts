import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { HttpClient } from "../src/server/http.ts";

process.env.DATABASE_PATH = ":memory:";
process.env.FLARESOLVERR_URL = "http://127.0.0.1:19819";
process.env.FLARESOLVERR_TIMEOUT_MS = "10000";

const { flaresolverrGet, FlareUnavailableError, __flareInternals } = await import("../src/server/flaresolverr.ts");
const { linuxdoCollector } = await import("../src/server/collectors/linuxdo.ts");

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  __flareInternals.resetForTest();
});

test("flaresolverrGet 严格串行互斥且复用同一个 session", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const cmds: string[] = [];

  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      const body = JSON.parse(String(init?.body ?? "{}")) as { cmd: string; url?: string };
      cmds.push(body.cmd);
      await new Promise((r) => setTimeout(r, 15));
      if (body.cmd === "sessions.create") {
        return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ status: "ok", solution: { status: 200, url: body.url, response: "ok:" + body.url } }),
        { status: 200 },
      );
    } finally {
      inFlight -= 1;
    }
  }) as typeof fetch;

  const results = await Promise.all([
    flaresolverrGet("https://example.com/1"),
    flaresolverrGet("https://example.com/2"),
    flaresolverrGet("https://example.com/3"),
  ]);

  assert.equal(maxInFlight, 1, "同一时刻最多只能有 1 个请求进入 FlareSolverr");
  assert.deepEqual(cmds, ["sessions.create", "request.get", "request.get", "request.get"]);
  assert.deepEqual(
    results.map((r) => r.body),
    ["ok:https://example.com/1", "ok:https://example.com/2", "ok:https://example.com/3"],
  );
});

test("Chrome 启动崩溃错误不触发重试或无 session 回退，并立即进入熔断冷却", async () => {
  const cmds: string[] = [];

  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { cmd: string; session?: string };
    cmds.push(`${body.cmd}:${body.session ?? "none"}`);
    if (body.cmd === "sessions.create") {
      return new Response(
        JSON.stringify({
          status: "error",
          message: "Error: Message: session not created: cannot connect to chrome at 127.0.0.1:48761",
        }),
        { status: 500 },
      );
    }
    return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
  }) as typeof fetch;

  await assert.rejects(() => flaresolverrGet("https://linux.do/c/welfare/36.rss"), /session not created/);
  assert.deepEqual(cmds, ["sessions.create:radar", "sessions.destroy:radar"]);

  // 熔断生效：下一次调用直接被拦截，绝不再请求网络
  const beforeCount = cmds.length;
  await assert.rejects(() => flaresolverrGet("https://linux.do/latest.rss"), FlareUnavailableError);
  assert.equal(cmds.length, beforeCount);
});

test("旧 session 失效（不含 Chrome 崩溃）允许销毁重建并重试一次", async () => {
  const cmds: string[] = [];
  let requestAttempts = 0;

  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { cmd: string; session?: string };
    cmds.push(body.cmd);
    if (body.cmd === "sessions.create" || body.cmd === "sessions.destroy") {
      return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    }
    requestAttempts += 1;
    if (requestAttempts === 1) {
      return new Response(JSON.stringify({ status: "error", message: "Error: session not found" }), { status: 500 });
    }
    return new Response(
      JSON.stringify({ status: "ok", solution: { status: 200, url: "https://linux.do", response: "<rss/>" } }),
      { status: 200 },
    );
  }) as typeof fetch;

  const res = await flaresolverrGet("https://linux.do/c/welfare/36.rss");
  assert.equal(res.body, "<rss/>");
  assert.deepEqual(cmds, ["sessions.create", "request.get", "sessions.destroy", "sessions.create", "request.get"]);
  assert.equal(__flareInternals.getState().consecutiveFailures, 0);
});

test("linuxdo 分类 RSS 因 FlareSolverr 失败后，兜底 latest.rss 只走直连不再二次撞 FlareSolverr", async () => {
  let flareCalls = 0;
  let directCalls = 0;

  globalThis.fetch = (async () => {
    flareCalls += 1;
    return new Response(JSON.stringify({ status: "error", message: "cannot connect to chrome" }), { status: 500 });
  }) as typeof fetch;

  const http = {
    text: async () => {
      directCalls += 1;
      return { status: 403, body: "Just a moment...", url: "", headers: new Headers(), bytes: Buffer.alloc(0), contentType: "" };
    },
    raw: async () => {
      throw new Error("unused");
    },
    json: async () => {
      throw new Error("unused");
    },
  } as unknown as HttpClient;

  await assert.rejects(
    () =>
      linuxdoCollector.collect({
        sourceId: "linuxdo-welfare",
        config: { categoryId: 36, rssSlug: "welfare", categoryName: "福利羊毛" },
        cursor: null,
        maxItems: 20,
        http,
        log: () => {},
      }),
    /已跳过 FlareSolverr 二次兜底/,
  );

  assert.equal(directCalls, 2);
  // 只有第 1 轮调用了 FlareSolverr（sessions.create + sessions.destroy = 2 次 fetch），第 2 轮 latest.rss 绝对没再发 Flare 请求
  assert.equal(flareCalls, 2);
});
