/**
 * Electron (and some Chromium hosts) may replace `globalThis.fetch` after page
 * bootstrap. Capturing the function identity at client construction then leaves
 * a dead binding that rejects without issuing a network request.
 *
 * When callers pass the realm's current `globalThis.fetch`, wrap it so each
 * request re-reads the live binding. Explicit test doubles keep their identity.
 */
export function bindFetchPort(fetch: typeof globalThis.fetch): typeof globalThis.fetch {
  if (fetch !== globalThis.fetch) {
    return fetch;
  }
  return (input, init) => globalThis.fetch(input, init);
}
