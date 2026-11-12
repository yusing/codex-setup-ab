import { expect, mock, test } from "bun:test";
import { createOfflineFetch } from "./test-support/offline-network";

test("ordinary fetch and preconnect reject external destinations before their transport runs", async () => {
  const transport = Object.assign(mock(async () => new Response("fixture")), { preconnect: mock(() => {}) });
  const guarded = createOfflineFetch(transport as typeof fetch);
  for (const value of ["https://catalog.example.invalid/models", "http://localhost.example.invalid/", "http://127.0.0.1.example.invalid/",
    "http://169.254.169.254/", "http://0.0.0.0/", "file:///tmp/fixture", "http://localhost@catalog.example.invalid/"]) {
    await expect(guarded(value)).rejects.toThrow("External network is disabled");
    expect(() => guarded.preconnect(value)).toThrow("External network is disabled");
  }
  await expect(guarded(new URL("https://catalog.example.invalid/"))).rejects.toThrow("External network is disabled");
  await expect(guarded(new Request("https://catalog.example.invalid/"))).rejects.toThrow("External network is disabled");
  await expect(guarded("http://127.0.0.1/", { proxy: "https://proxy.example.invalid/" })).rejects.toThrow("proxies are disabled");
  expect(transport).not.toHaveBeenCalled();
  expect(transport.preconnect).not.toHaveBeenCalled();
});

test("loopback URL forms stay usable without automatic redirects or external proxy changes", async () => {
  const originalUpper = process.env.NO_PROXY, originalLower = process.env.no_proxy;
  const observed: Array<{ input: unknown; redirect: unknown }> = [];
  const transport = Object.assign(async (input: unknown, init?: BunFetchRequestInit) => {
    observed.push({ input, redirect: init?.redirect }); return new Response("fixture");
  }, { preconnect: () => {} });
  const guarded = createOfflineFetch(transport as typeof fetch);
  try {
    process.env.NO_PROXY = "preserved.example.invalid"; process.env.no_proxy = "preserved.example.invalid";
    for (const url of ["http://localhost/", "http://127.0.0.2/", "http://127.42.3.9/", "http://[::1]/"]) {
      expect(await (await guarded(url)).text()).toBe("fixture");
      guarded.preconnect(url);
    }
    await guarded(new Request("http://127.0.0.1/", { redirect: "follow" }));
    await guarded("http://127.0.0.1/", { redirect: "manual" });
    expect(observed.map(item => item.redirect)).toEqual(["error", "error", "error", "error", "error", "manual"]);
    expect(process.env.NO_PROXY).toBe("preserved.example.invalid,localhost,127.0.0.2,127.42.3.9,[::1],::1,127.0.0.1");
    expect(process.env.no_proxy).toBe(process.env.NO_PROXY);
  } finally {
    if (originalUpper === undefined) delete process.env.NO_PROXY; else process.env.NO_PROXY = originalUpper;
    if (originalLower === undefined) delete process.env.no_proxy; else process.env.no_proxy = originalLower;
  }
});

test("the installed guard permits real loopback fixtures and stops redirect escape", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    return new URL(request.url).pathname === "/redirect"
      ? Response.redirect("https://catalog.example.invalid/must-not-be-requested") : new Response("local fixture");
  } });
  try {
    const origin = `http://127.0.0.1:${server.port}`;
    expect(await (await fetch(origin)).text()).toBe("local fixture");
    await expect(fetch(`${origin}/redirect`)).rejects.toThrow();
    const response = await fetch(`${origin}/redirect`, { redirect: "manual" });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://catalog.example.invalid/must-not-be-requested");
    await expect(fetch("https://catalog.example.invalid/no-transport")).rejects.toThrow("External network is disabled");
  } finally { server.stop(true); }
});

test("intentional fetch mocks replace and restore the installed guard", async () => {
  const guarded = globalThis.fetch;
  globalThis.fetch = mock(async () => Response.json({ data: [] })) as unknown as typeof fetch;
  try { expect(await (await fetch("https://catalog.example.invalid/mock-only")).json()).toEqual({ data: [] }); }
  finally { globalThis.fetch = guarded; }
  await expect(fetch("https://catalog.example.invalid/blocked-after-mock")).rejects.toThrow("External network is disabled");
});
