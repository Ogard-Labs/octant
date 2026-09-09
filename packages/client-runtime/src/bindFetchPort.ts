/**
 * Electron (and some Chromium hosts) may replace `globalThis.fetch` after page
 * bootstrap. Capturing the function identity at client construction then leaves
 * a dead binding that rejects without issuing a network request.
 *
 * When callers pass the realm's current `globalThis.fetch`, wrap it so each
 * request re-reads the live binding and sets `redirect: "error"` unless the
 * caller already chose a redirect mode. Default fetch following would otherwise
 * resend `x-octant-window-capability` onto a later hop — including HTTPS →
 * non-loopback HTTP — which the launch parser never judged.
 *
 * Explicit test doubles keep their identity. Wrapping them would break
 * `expect(port).toBe(double)` and exact `RequestInit` matches across the
 * client-runtime suite. Those callers must set `redirect: "error"` themselves
 * on capability-bearing requests.
 */
export function bindFetchPort(fetch: typeof globalThis.fetch): typeof globalThis.fetch {
  if (fetch !== globalThis.fetch) {
    return fetch;
  }
  return (input, init) => globalThis.fetch(input, withCapabilityRedirect(init));
}

function withCapabilityRedirect(init?: RequestInit): RequestInit {
  if (init !== undefined && init.redirect !== undefined) {
    return init;
  }
  return { ...init, redirect: "error" };
}
