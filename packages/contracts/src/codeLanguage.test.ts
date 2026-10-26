import { describe, expect, it } from "vitest";
import {
  CodeLanguageRefusalReason,
  decodeCodeLanguageDocumentRequest,
  decodeCodeLanguageDocumentResult,
  decodeCodeLanguageReadRequest,
  decodeCodeLanguageReadResult,
  MAX_CODE_LANGUAGE_DEFINITION_TARGETS,
  MAX_CODE_LANGUAGE_DIAGNOSTIC_MESSAGE_LENGTH,
  MAX_CODE_LANGUAGE_DIAGNOSTICS,
  MAX_CODE_LANGUAGE_DOCUMENT_TEXT_LENGTH,
} from "./codeLanguage";

const scope = {
  threadId: "30000000-0000-4000-8000-000000000001",
  checkoutId: "30000000-0000-4000-8000-000000000002",
  fileId: "30000000-0000-4000-8000-000000000003",
};
const range = { start: { line: 4, character: 2 }, end: { line: 4, character: 9 } };

function diagnostic(overrides: Record<string, unknown> = {}) {
  return {
    path: "src/main.ts",
    range,
    severity: "error",
    message: "Type 'string' is not assignable to type 'number'.",
    source: "typescript",
    ...overrides,
  };
}

describe("Code language read contracts", () => {
  it("decodes a diagnostics read and a definition read for one file of a Code thread", () => {
    expect(decodeCodeLanguageReadRequest({ kind: "diagnostics", ...scope })).toEqual({
      kind: "diagnostics",
      ...scope,
    });
    expect(
      decodeCodeLanguageReadRequest({
        kind: "definition",
        ...scope,
        position: { line: 0, character: 12 },
      }).kind,
    ).toBe("definition");
  });

  it("refuses a read that names no file, a raw path, a negative position, or an unknown kind", () => {
    for (const request of [
      { kind: "diagnostics", threadId: scope.threadId, checkoutId: scope.checkoutId },
      { kind: "diagnostics", ...scope, path: "/etc/passwd" },
      { kind: "definition", ...scope },
      { kind: "definition", ...scope, position: { line: -1, character: 0 } },
      { kind: "definition", ...scope, position: { line: 0, character: 0.5 } },
      { kind: "hover", ...scope, position: { line: 0, character: 0 } },
      { kind: "diagnostics", ...scope, threadId: "not-a-thread" },
    ]) {
      expect(() => decodeCodeLanguageReadRequest(request)).toThrow();
    }
  });

  it("carries diagnostics as checkout-relative paths with bounded messages and source labels", () => {
    const decoded = decodeCodeLanguageReadResult({
      status: "diagnostics",
      ...scope,
      diagnostics: [diagnostic(), diagnostic({ severity: "hint", path: "src/other.ts" })],
      truncated: false,
    });
    expect(decoded.status).toBe("diagnostics");

    for (const refused of [
      diagnostic({ path: "/home/person/project/src/main.ts" }),
      diagnostic({ path: "../outside.ts" }),
      diagnostic({ severity: "fatal" }),
      diagnostic({ message: "x".repeat(MAX_CODE_LANGUAGE_DIAGNOSTIC_MESSAGE_LENGTH + 1) }),
      diagnostic({ source: "" }),
      diagnostic({ source: "/opt/tools/bin/server" }),
      diagnostic({ range: { start: { line: 5, character: 0 }, end: { line: 4, character: 0 } } }),
      diagnostic({ code: 2322 }),
    ]) {
      expect(() =>
        decodeCodeLanguageReadResult({
          status: "diagnostics",
          ...scope,
          diagnostics: [refused],
          truncated: false,
        }),
      ).toThrow();
    }
    expect(() =>
      decodeCodeLanguageReadResult({
        status: "diagnostics",
        ...scope,
        diagnostics: Array.from({ length: MAX_CODE_LANGUAGE_DIAGNOSTICS + 1 }, () => diagnostic()),
        truncated: true,
      }),
    ).toThrow();
  });

  it("returns a definition outside the checkout as a label with no path or content", () => {
    const decoded = decodeCodeLanguageReadResult({
      status: "definition",
      ...scope,
      targets: [
        { kind: "checkout-location", path: "node_modules/pkg/index.d.ts", range },
        { kind: "outside-checkout", label: "bundled-library" },
        { kind: "outside-checkout", label: "elsewhere" },
      ],
    });
    expect(decoded.status === "definition" ? decoded.targets.length : 0).toBe(3);

    for (const target of [
      { kind: "outside-checkout", label: "bundled-library", path: "lib.dom.d.ts" },
      { kind: "outside-checkout", label: "elsewhere", range },
      { kind: "outside-checkout", label: "home-directory" },
      { kind: "checkout-location", path: "/usr/lib/node/lib.d.ts", range },
    ]) {
      expect(() =>
        decodeCodeLanguageReadResult({ status: "definition", ...scope, targets: [target] }),
      ).toThrow();
    }
    expect(() =>
      decodeCodeLanguageReadResult({
        status: "definition",
        ...scope,
        targets: Array.from({ length: MAX_CODE_LANGUAGE_DEFINITION_TARGETS + 1 }, () => ({
          kind: "outside-checkout",
          label: "elsewhere",
        })),
      }),
    ).toThrow();
  });

  it("names every refusal and every temporary unavailability, and nothing else", () => {
    for (const reason of CodeLanguageRefusalReason.literals) {
      expect(decodeCodeLanguageReadResult({ status: "refused", reason })).toEqual({
        status: "refused",
        reason,
      });
    }
    for (const reason of ["starting", "crashed", "timed-out"]) {
      expect(decodeCodeLanguageReadResult({ status: "unavailable", reason }).status).toBe(
        "unavailable",
      );
    }
    expect(() => decodeCodeLanguageReadResult({ status: "refused", reason: "denied" })).toThrow();
    expect(() =>
      decodeCodeLanguageReadResult({ status: "refused", reason: "turned-off", detail: "x" }),
    ).toThrow();
    expect(() =>
      decodeCodeLanguageReadResult({ status: "unavailable", reason: "plan-read-only" }),
    ).toThrow();
  });

  it("opens a document by checkout-relative path and names it by reference afterwards", () => {
    const opened = decodeCodeLanguageDocumentRequest({
      kind: "open",
      threadId: scope.threadId,
      checkoutId: scope.checkoutId,
      path: "src/main.ts",
      text: "export const a = 1;\n",
    });
    expect(opened.kind).toBe("open");
    expect(decodeCodeLanguageDocumentRequest({ kind: "change", ...scope, text: "" }).kind).toBe(
      "change",
    );
    expect(decodeCodeLanguageDocumentRequest({ kind: "close", ...scope }).kind).toBe("close");

    for (const request of [
      { kind: "open", ...scope, path: "src/main.ts", text: "" },
      {
        kind: "open",
        threadId: scope.threadId,
        checkoutId: scope.checkoutId,
        path: "/etc/passwd",
        text: "",
      },
      {
        kind: "open",
        threadId: scope.threadId,
        checkoutId: scope.checkoutId,
        path: "../outside.ts",
        text: "",
      },
      { kind: "change", ...scope, path: "src/main.ts", text: "" },
      { kind: "change", ...scope, text: "x".repeat(MAX_CODE_LANGUAGE_DOCUMENT_TEXT_LENGTH + 1) },
      { kind: "save", ...scope },
    ]) {
      expect(() => decodeCodeLanguageDocumentRequest(request)).toThrow();
    }
  });

  it("answers a document request as synced, too large, unavailable, or refused", () => {
    expect(decodeCodeLanguageDocumentResult({ status: "synced", ...scope }).status).toBe("synced");
    expect(decodeCodeLanguageDocumentResult({ status: "too-large", ...scope }).status).toBe(
      "too-large",
    );
    expect(
      decodeCodeLanguageDocumentResult({ status: "refused", reason: "path-outside-checkout" })
        .status,
    ).toBe("refused");
    expect(() =>
      decodeCodeLanguageDocumentResult({ status: "synced", ...scope, path: "src/main.ts" }),
    ).toThrow();
  });
});
