import { describe, expect, it } from "vitest";
import {
  CODE_LANGUAGE_TOOL_DEFINITIONS,
  decodeProviderToolDefinition,
  decodeToolActionCapability,
  listClosedToolCatalog,
  lookupClosedToolCatalogEntry,
  type ToolApprovalClass,
} from "./index";

describe("closed tool catalog", () => {
  it("indexes existing contract capability ids as a closed Octant-owned set", () => {
    const ids = listClosedToolCatalog()
      .map((entry) => entry.name)
      .sort();
    expect(ids).toEqual([
      "browser-automation",
      "code-definition",
      "code-diagnostics",
      "computer-use",
      "harness-ask-user",
      "harness-bash",
      "harness-context-remaining",
      "harness-delegate",
      "harness-edit",
      "harness-glob",
      "harness-goal",
      "harness-goal-check",
      "harness-grep",
      "harness-journal-lookup",
      "harness-read",
      "harness-second-opinion",
      "harness-todo-write",
      "harness-web-fetch",
      "harness-web-search",
      "harness-write",
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

  it("asks afresh on a marked thread for every tool in an irreversible or authority-bearing class", () => {
    // The thread-elevation step forces a fresh confirmation per catalog entry,
    // not per class, so an entry added to one of these classes without the
    // flag would let Full access cover it on a marked thread.
    const authorityBearing = new Set<ToolApprovalClass>([
      "destructive-irreversible",
      "credential-secret-access",
      "access-outside-project",
      "privilege-expansion",
    ]);
    const escaping = listClosedToolCatalog()
      .filter((entry) => authorityBearing.has(entry.approvalClass))
      .filter((entry) => !entry.irreversibleUnderTaint)
      .map((entry) => entry.name);
    expect(escaping).toEqual([]);
  });
});

describe("native harness catalog entries", () => {
  it("keeps the shell out of Chat and Work, and every read available in Work and Code", () => {
    const bash = lookupClosedToolCatalogEntry(
      decodeToolActionCapability({ id: "harness-bash", version: 1 }),
    );
    expect(bash?.modes).toEqual(["code"]);
    expect(bash?.approvalClass).toBe("shell-commands");
    expect(bash?.irreversibleUnderTaint).toBe(true);
    const read = lookupClosedToolCatalogEntry(
      decodeToolActionCapability({ id: "harness-read", version: 1 }),
    );
    expect(read?.modes).toEqual(["work", "code"]);
    expect(read?.approvalClass).toBe("project-file-reads");
  });

  it("refuses a harness tool call whose arguments do not match the tool", () => {
    const edit = lookupClosedToolCatalogEntry(
      decodeToolActionCapability({ id: "harness-edit", version: 1 }),
    );
    expect(() => edit!.decodeArguments({ path: "a.ts", oldText: "", newText: "x" })).toThrow();
    expect(() =>
      edit!.decodeArguments({ path: "a.ts", oldText: "a", newText: "b", extra: 1 }),
    ).toThrow();
    expect(edit!.decodeArguments({ path: "a.ts", oldText: "a", newText: "b" })).toEqual({
      path: "a.ts",
      oldText: "a",
      newText: "b",
    });
  });
});

describe("Code language read entries", () => {
  const diagnostics = lookupClosedToolCatalogEntry(
    decodeToolActionCapability({ id: "code-diagnostics", version: 1 }),
  );
  const definition = lookupClosedToolCatalogEntry(
    decodeToolActionCapability({ id: "code-definition", version: 1 }),
  );

  it("reads inside the checkout in Code only, never asks, and never marks the thread", () => {
    for (const entry of [diagnostics, definition]) {
      expect(entry).toMatchObject({
        owner: "core",
        modes: ["code"],
        requiredCapabilityClass: "filesystem",
        approvalClass: "project-file-reads",
        irreversibleUnderTaint: false,
        resultTaintsThread: false,
        requiresAppManagedTools: true,
      });
    }
  });

  it("takes a checkout-relative path and a one-based position, and nothing else", () => {
    expect(diagnostics?.decodeArguments({ path: "src/a.ts" })).toEqual({ path: "src/a.ts" });
    expect(definition?.decodeArguments({ path: "src/a.ts", line: 2, column: 14 })).toEqual({
      path: "src/a.ts",
      line: 2,
      column: 14,
    });
    for (const path of ["/etc/passwd", "../outside.ts", "src/../../a.ts", "src\\a.ts", ""]) {
      expect(() => diagnostics?.decodeArguments({ path })).toThrow();
    }
    expect(() => diagnostics?.decodeArguments({ path: "a.ts", fileId: "x" })).toThrow();
    expect(() => definition?.decodeArguments({ path: "a.ts", line: 0, column: 1 })).toThrow();
    expect(() => definition?.decodeArguments({ path: "a.ts", line: 1, column: 0 })).toThrow();
    expect(() => definition?.decodeArguments({ path: "a.ts", line: 1.5, column: 1 })).toThrow();
    expect(() => definition?.decodeArguments({ path: "a.ts" })).toThrow();
  });

  it("offers each read as a provider tool definition every transport can carry", () => {
    expect(CODE_LANGUAGE_TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual([
      "octant_code_diagnostics",
      "octant_code_definition",
    ]);
    for (const tool of CODE_LANGUAGE_TOOL_DEFINITIONS) {
      expect(decodeProviderToolDefinition(tool)).toEqual(tool);
    }
  });
});
