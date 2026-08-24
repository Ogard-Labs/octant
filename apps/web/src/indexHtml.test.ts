import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("packaged renderer policy", () => {
  it("ships a strict CSP meta that survives the Vite build", () => {
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
