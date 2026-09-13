import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function cspDirectives(content: string): Map<string, string> {
  const directives = new Map<string, string>();
  for (const rawDirective of content.split(";")) {
    const trimmed = rawDirective.trim();
    if (trimmed === "") continue;
    const [rawName, ...sources] = trimmed.split(/\s+/);
    if (rawName === undefined) continue;
    directives.set(rawName.toLowerCase(), sources.join(" "));
  }
  return directives;
}

describe("packaged renderer policy", () => {
  // This reads the checked-in document, so it cannot speak for what the build
  // emits; `validatePackagedRendererPolicy` checks the copy inside the packaged
  // app. Framing refusal is the response header the remote route policy sets:
  // user agents ignore `frame-ancestors` in a `meta` element.
  it("declares a strict CSP on the renderer document", () => {
    const indexHtml = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    const csp = indexHtml.match(
      /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"\s*\/?\s*>/i,
    )?.[1];

    expect(csp).toBeDefined();
    if (csp === undefined) return;
    const directives = cspDirectives(csp);
    expect(directives.get("default-src")).toBe("'self'");
    expect(directives.get("script-src")).toBe("'self'");
    expect(directives.get("object-src")).toBe("'none'");
    expect(directives.get("base-uri")).toBe("'none'");
    // Synthesized speech plays from a blob URL; without this the default-src
    // fallback refuses the audio element and read-aloud fails silently.
    expect(directives.get("media-src")).toBe("'self' blob:");
    // Packaged `file://` and Vite `localhost` renderers talk to a loopback
    // server that is not `'self'`. Remote clients are same-origin. IPv6
    // bracket sources are not valid host-sources and only produce console
    // noise; the host binds 127.0.0.1, so they are not a supported origin.
    expect(directives.get("connect-src")).toBe(
      "'self' http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*",
    );
    expect(directives.has("frame-ancestors")).toBe(false);
    expect(csp).not.toMatch(/\[::1]/);
  });
});
