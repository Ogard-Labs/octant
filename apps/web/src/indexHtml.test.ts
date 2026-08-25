import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("packaged renderer policy", () => {
  // This reads the checked-in document, so it cannot speak for what the build
  // emits; `validatePackagedRendererPolicy` checks the copy inside the packaged
  // app. The refusal to be framed comes from the response header the remote
  // route policy sets, not from the directive below, which user agents ignore
  // in a `meta` element.
  it("declares a strict CSP on the renderer document", () => {
    const indexHtml = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    const csp = indexHtml.match(
      /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"\s*\/?\s*>/i,
    )?.[1];

    expect(csp).toBeDefined();
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("connect-src 'self'");
  });
});
