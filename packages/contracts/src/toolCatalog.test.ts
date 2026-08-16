import { describe, expect, it } from "vitest";
import {
  decodeToolActionCapability,
  listClosedToolCatalog,
  lookupClosedToolCatalogEntry,
} from "./index";

describe("closed tool catalog", () => {
  it("indexes existing contract capability ids as a closed Octant-owned set", () => {
    const ids = listClosedToolCatalog()
      .map((entry) => entry.name)
      .sort();
    expect(ids).toEqual([
      "browser-automation",
      "computer-use",
      "mcp-tool",
      "repository-validation",
    ]);
    expect(
      lookupClosedToolCatalogEntry(
        decodeToolActionCapability({ id: "browser-automation", version: 1 }),
      )?.owner,
    ).toBe("core");
    expect(
      lookupClosedToolCatalogEntry(decodeToolActionCapability({ id: "mcp-tool", version: 1 }))
        ?.owner,
    ).toBe("extension-namespaced");
    expect(
      lookupClosedToolCatalogEntry(
        decodeToolActionCapability({ id: "model-invented-shell", version: 1 }),
      ),
    ).toBeUndefined();
  });

  it("rejects excess properties on catalog argument schemas", () => {
    const browser = lookupClosedToolCatalogEntry(
      decodeToolActionCapability({ id: "browser-automation", version: 1 }),
    );
    expect(browser).toBeDefined();
    expect(() =>
      browser!.decodeArguments({
        profileMode: "isolated",
        allowedOrigins: ["https://example.com"],
        credentialFieldProtection: true,
        maxConcurrentTabs: 1,
        sessionTimeoutMs: 300_000,
        extra: true,
      }),
    ).toThrow();
  });
});
