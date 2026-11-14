import { authorizeSandboxHostRequest, sandboxToolPolicy } from "../process/sandboxRuntimePolicy";
import { createPinnedFetch } from "./nativeHarnessWebFetch";
import { SearxngClient, type SearxngFetch } from "../chat/research/searxngClient";
import type { NativeHarnessToolPorts } from "./nativeHarnessTools";

/**
 * The harness `web-search` port backed by the SearXNG endpoint in Chat
 * settings, or nothing when no endpoint is set so the tool is not offered and
 * no request can leave the host. Call it when a turn's tools are composed:
 * the endpoint can be set, changed, or cleared while the host runs.
 */
export function searxngHarnessWebSearch(options: {
  readonly readBaseUrl: () => string | undefined;
  readonly fetch?: SearxngFetch;
}): NativeHarnessToolPorts["webSearch"] {
  if (options.readBaseUrl() === undefined) return undefined;
  return async (input) => {
    // Read again per call: a turn may outlive the setting it started with,
    // and a cleared endpoint must stop requests immediately.
    const baseUrl = options.readBaseUrl();
    if (baseUrl === undefined) return [];
    const found = await new SearxngClient({
      baseUrl,
      ...(sandboxToolPolicy() === undefined
        ? options.fetch === undefined
          ? {}
          : { fetch: options.fetch }
        : {
            fetch: async (target: string | URL | Request, init?: RequestInit) => {
              const url = new URL(target instanceof Request ? target.url : String(target));
              authorizeSandboxHostRequest(url);
              // A search endpoint gets no ambient local transport or redirect bypass.
              return createPinnedFetch()(url, {
                signal: init?.signal ?? new AbortController().signal,
                headers: { accept: "application/json" },
                redirect: "manual",
              });
            },
          }),
    }).search(input);
    return found.results.map((result) => ({
      title: result.title,
      url: result.url,
      snippet: result.snippet,
    }));
  };
}
