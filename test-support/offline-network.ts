/** Ordinary tests may use their local HTTP fixtures, never external fetches. */
function loopbackUrl(input: string | URL | Request): URL {
  const url = new URL(input instanceof Request ? input.url : input);
  const hostname = url.hostname.toLowerCase();
  const loopback = hostname === "localhost" || hostname === "localhost." || hostname === "[::1]"
    || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
  if (!["http:", "https:"].includes(url.protocol) || !loopback || url.username || url.password) {
    throw new Error(`External network is disabled in ordinary tests: ${url.origin}`);
  }
  return url;
}

function localProxyBypass(url: URL): void {
  // Extend only the loopback destination already checked above. In particular,
  // retain the operator's proxy settings for every external destination.
  const host = url.hostname;
  const additions = host === "[::1]" ? [host, "::1"] : [host];
  for (const key of ["NO_PROXY", "no_proxy"] as const) {
    const previous = process.env[key] ?? process.env[key === "NO_PROXY" ? "no_proxy" : "NO_PROXY"] ?? "";
    process.env[key] = [...new Set([...previous.split(",").filter(Boolean), ...additions])].join(",");
  }
}

export function createOfflineFetch(nativeFetch: typeof fetch): typeof fetch {
  const guarded = (async (input: string | URL | Request, init?: BunFetchRequestInit): Promise<Response> => {
    const url = loopbackUrl(input);
    if (init?.proxy) throw new Error("Explicit fetch proxies are disabled in ordinary tests");
    localProxyBypass(url);
    // Native automatic redirect following could leave loopback without passing
    // this guard again. Tests can inspect a redirect explicitly in manual mode.
    const redirect = init?.redirect ?? (input instanceof Request ? input.redirect : undefined);
    return nativeFetch(input, { ...init, redirect: redirect === "manual" ? "manual" : "error" });
  }) as typeof fetch;
  guarded.preconnect = (input, options) => {
    const url = loopbackUrl(input);
    localProxyBypass(url);
    nativeFetch.preconnect(input, options);
  };
  return guarded;
}

globalThis.fetch = createOfflineFetch(globalThis.fetch);
