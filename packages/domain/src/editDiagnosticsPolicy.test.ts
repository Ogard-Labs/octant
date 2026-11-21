import { describe, expect, it } from "vitest";
import { decodeCodeRelativePath } from "@octant/contracts";
import type {
  CodeLanguageDiagnostic,
  CodeLanguageDiagnosticSeverity,
} from "@octant/contracts/code-language";
import {
  EDIT_DIAGNOSTICS_TIMEOUT_MS,
  MAX_EDIT_DIAGNOSTIC_ERRORS,
  MAX_EDIT_DIAGNOSTIC_MESSAGE_LENGTH,
  formatEditDiagnostics,
} from "./editDiagnosticsPolicy";

function diagnostic(overrides: {
  readonly path?: string;
  readonly line?: number;
  readonly character?: number;
  readonly severity?: CodeLanguageDiagnosticSeverity;
  readonly message?: string;
}): CodeLanguageDiagnostic {
  const line = overrides.line ?? 0;
  const character = overrides.character ?? 0;
  return {
    path: decodeCodeRelativePath(overrides.path ?? "src/index.ts"),
    range: {
      start: { line, character },
      end: { line, character: character + 1 },
    },
    severity: overrides.severity ?? "error",
    message: overrides.message ?? "Type error.",
    source: "typescript",
  };
}

describe("edit diagnostics policy", () => {
  it("keeps the documented bounds for timeout, error count, and message length", () => {
    expect(EDIT_DIAGNOSTICS_TIMEOUT_MS).toBe(3_500);
    expect(MAX_EDIT_DIAGNOSTIC_ERRORS).toBe(5);
    expect(MAX_EDIT_DIAGNOSTIC_MESSAGE_LENGTH).toBe(200);
  });

  it("reports no errors for a clean file and ignores warnings, information, and hints", () => {
    expect(formatEditDiagnostics("src/index.ts", [])).toBe("No errors in src/index.ts");
    expect(
      formatEditDiagnostics("src/index.ts", [
        diagnostic({ severity: "warning", message: "Unused variable." }),
        diagnostic({ severity: "information", message: "Inferred type." }),
        diagnostic({ severity: "hint", message: "Could be const." }),
      ]),
    ).toBe("No errors in src/index.ts");
  });

  it("formats errors with one-based line and column numbers and omits non-error severities", () => {
    const formatted = formatEditDiagnostics("src/app.ts", [
      diagnostic({
        path: "src/app.ts",
        line: 0,
        character: 4,
        severity: "warning",
        message: "Unused import.",
      }),
      diagnostic({
        path: "src/app.ts",
        line: 9,
        character: 12,
        severity: "error",
        message: "Type 'string' is not assignable to type 'number'.",
      }),
      diagnostic({
        path: "src/app.ts",
        line: 14,
        character: 0,
        severity: "error",
        message: "Cannot find name 'missing'.",
      }),
    ]);

    expect(formatted).toBe(
      [
        "src/app.ts:10:13 Type 'string' is not assignable to type 'number'.",
        "src/app.ts:15:1 Cannot find name 'missing'.",
      ].join("\n"),
    );
  });

  it("lists up to five errors without a remainder line, and summarizes anything past five", () => {
    const five = Array.from({ length: 5 }, (_, index) =>
      diagnostic({ path: "a.ts", line: index, character: 0, message: `Error ${index + 1}` }),
    );
    expect(formatEditDiagnostics("a.ts", five)).toBe(
      [
        "a.ts:1:1 Error 1",
        "a.ts:2:1 Error 2",
        "a.ts:3:1 Error 3",
        "a.ts:4:1 Error 4",
        "a.ts:5:1 Error 5",
      ].join("\n"),
    );

    const eight = Array.from({ length: 8 }, (_, index) =>
      diagnostic({ path: "a.ts", line: index, character: 1, message: `Error ${index + 1}` }),
    );
    expect(formatEditDiagnostics("a.ts", eight)).toBe(
      [
        "a.ts:1:2 Error 1",
        "a.ts:2:2 Error 2",
        "a.ts:3:2 Error 3",
        "a.ts:4:2 Error 4",
        "a.ts:5:2 Error 5",
        "and 3 more",
      ].join("\n"),
    );
  });

  it("truncates long diagnostic messages to 200 characters and collapses newlines", () => {
    const exact = "a".repeat(200);
    expect(formatEditDiagnostics("a.ts", [diagnostic({ path: "a.ts", message: exact })])).toBe(
      `a.ts:1:1 ${exact}`,
    );

    const tooLong = `Line one\n${"b".repeat(250)}`;
    const formatted = formatEditDiagnostics("a.ts", [
      diagnostic({ path: "a.ts", message: tooLong }),
    ]);
    expect(formatted.includes("\n")).toBe(false);
    const messagePart = formatted.slice("a.ts:1:1 ".length);
    expect(messagePart.length).toBeLessThanOrEqual(200);
    expect(messagePart.endsWith("…")).toBe(true);
    expect(messagePart.startsWith("Line one b")).toBe(true);

    const withSurrogateAtBoundary = `${"c".repeat(198)}😀tail`;
    const cutSurrogate = formatEditDiagnostics("a.ts", [
      diagnostic({ path: "a.ts", message: withSurrogateAtBoundary }),
    ]);
    const surrogateMessage = cutSurrogate.slice("a.ts:1:1 ".length);
    expect(surrogateMessage.length).toBeLessThanOrEqual(200);
    expect(surrogateMessage).toBe(`${"c".repeat(198)}…`);
  });
});
