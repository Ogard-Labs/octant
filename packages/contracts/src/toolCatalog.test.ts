import { describe, expect, it } from "vitest";
import {
  CODE_LANGUAGE_TOOL_DEFINITION,
  MAX_CODE_LANGUAGE_AGENT_REFERENCES,
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
      "code-language",
      "computer-use",
      "harness-ask-user",
      "harness-bash",
      "harness-context-remaining",
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
  it("keeps the shell out of Chat, shares it between Work and Code, and every read available in both", () => {
    const bash = lookupClosedToolCatalogEntry(
      decodeToolActionCapability({ id: "harness-bash", version: 1 }),
    );
    expect(bash?.modes).toEqual(["work", "code"]);
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

describe("Code language read entry", () => {
  const language = lookupClosedToolCatalogEntry(
    decodeToolActionCapability({ id: "code-language", version: 1 }),
  );

  it("reads inside the checkout in Code only, never asks, and never marks the thread", () => {
    expect(language).toMatchObject({
      owner: "core",
      modes: ["code"],
      requiredCapabilityClass: "filesystem",
      approvalClass: "project-file-reads",
      irreversibleUnderTaint: false,
      resultTaintsThread: false,
      requiresAppManagedTools: true,
    });
  });

  it("takes an operation, a checkout-relative or extra-folder path, and a one-based position, and nothing else", () => {
    const decode = (value: unknown) => language?.decodeArguments(value);
    expect(decode({ operation: "diagnostics", path: "src/a.ts" })).toEqual({
      operation: "diagnostics",
      path: "src/a.ts",
    });
    expect(decode({ operation: "definition", path: "src/a.ts", line: 2, column: 14 })).toEqual({
      operation: "definition",
      path: "src/a.ts",
      line: 2,
      column: 14,
    });
    expect(
      decode({
        operation: "references",
        path: "src/a.ts",
        line: 2,
        column: 14,
        includeDeclaration: true,
      }),
    ).toMatchObject({ operation: "references", includeDeclaration: true });
    for (const path of ["../outside.ts", "src/../../a.ts", "src\\a.ts", ""]) {
      expect(() => decode({ operation: "diagnostics", path })).toThrow();
    }
    // A file in an extra folder is named by absolute path; the host refuses any
    // absolute path outside the Project's folders, so the schema only carries it.
    expect(decode({ operation: "diagnostics", path: "/notes/a.ts" })).toMatchObject({
      path: "/notes/a.ts",
    });
    expect(() => decode({ operation: "diagnostics", path: "/notes/../a.ts" })).toThrow();
    expect(() => decode({ operation: "diagnostics", path: "a.ts", fileId: "x" })).toThrow();
    expect(() => decode({ path: "a.ts" })).toThrow();
    expect(() => decode({ operation: "rename", path: "a.ts", line: 1, column: 1 })).toThrow();
    for (const operation of ["definition", "references"]) {
      expect(() => decode({ operation, path: "a.ts", line: 0, column: 1 })).toThrow();
      expect(() => decode({ operation, path: "a.ts", line: 1, column: 0 })).toThrow();
      expect(() => decode({ operation, path: "a.ts", line: 1.5, column: 1 })).toThrow();
      expect(() => decode({ operation, path: "a.ts" })).toThrow();
    }
  });

  it("offers the reads as one provider tool definition every transport can carry", () => {
    expect(CODE_LANGUAGE_TOOL_DEFINITION.name).toBe("octant_code");
    expect(CODE_LANGUAGE_TOOL_DEFINITION.description).toContain(
      `at most ${MAX_CODE_LANGUAGE_AGENT_REFERENCES}`,
    );
    expect(decodeProviderToolDefinition(CODE_LANGUAGE_TOOL_DEFINITION)).toEqual(
      CODE_LANGUAGE_TOOL_DEFINITION,
    );
  });
});
