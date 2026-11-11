import { Schema } from "effect";
import {
  CodeLanguageRange,
  type CodeIntelligenceFeature,
  type CodeIntelligenceItem,
  type CodeIntelligenceAnswer,
} from "@octant/contracts/code-language";
import { boundedDiagnosticMessage } from "./languageServerResults";

export const INTELLIGENCE_METHODS = {
  completion: "textDocument/completion",
  hover: "textDocument/hover",
  signature: "textDocument/signatureHelp",
  symbols: "textDocument/documentSymbol",
  formatting: "textDocument/formatting",
} as const;
export const INTELLIGENCE_CAPABILITIES = {
  completion: "completionProvider",
  hover: "hoverProvider",
  signature: "signatureHelpProvider",
  symbols: "documentSymbolProvider",
  formatting: "documentFormattingProvider",
} as const;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const range = (value: unknown) => {
  try {
    return Schema.decodeUnknownSync(CodeLanguageRange)(value);
  } catch {
    return undefined;
  }
};

/** Only bounded text and ranges cross the seam. No commands, URIs, imports or HTML. */
export function intelligenceItems(
  feature: CodeIntelligenceFeature,
  value: unknown,
  root: string,
): Pick<CodeIntelligenceAnswer, "items" | "truncated" | "activeSignature" | "activeParameter"> {
  const clean = (text: string, maximum = 8192) =>
    boundedDiagnosticMessage(text, root).slice(0, maximum);
  const docs = (input: unknown): string =>
    typeof input === "string"
      ? input
      : record(input) && typeof input.value === "string"
        ? input.value
        : Array.isArray(input)
          ? input.map(docs).join("\n\n").slice(0, 8192)
          : "";
  const output: CodeIntelligenceItem[] = [];
  let omitted = false;
  if (feature === "hover") {
    const text = clean(docs(record(value) ? value.contents : value));
    return { items: text === "" ? [] : [{ label: "Documentation", text }], truncated: false };
  }
  const candidates: unknown[] = Array.isArray(value)
    ? value
    : record(value) && Array.isArray(feature === "signature" ? value.signatures : value.items)
      ? ((feature === "signature" ? value.signatures : value.items) as unknown[])
      : [];
  const visit = (entries: ReadonlyArray<unknown>, depth: number) => {
    if (depth > 16) {
      omitted = true;
      return;
    }
    for (const entry of entries) {
      if (output.length >= 256) {
        omitted = true;
        break;
      }
      if (!record(entry)) continue;
      if (feature === "formatting") {
        const target = range(entry.range);
        if (
          target === undefined ||
          typeof entry.newText !== "string" ||
          entry.newText.length > 16384
        ) {
          omitted = true;
          continue;
        }
        output.push({ label: "Format", text: entry.newText, range: target });
        continue;
      }
      const name = feature === "symbols" ? entry.name : entry.label;
      if (typeof name !== "string" || name.length > 512) {
        omitted = true;
        continue;
      }
      const target = range(
        feature === "symbols"
          ? (entry.selectionRange ?? entry.range)
          : record(entry.textEdit)
            ? entry.textEdit.range
            : undefined,
      );
      // A completion that requires changes elsewhere must not be half-applied.
      if (
        feature === "completion" &&
        (entry.command !== undefined ||
          entry.additionalTextEdits !== undefined ||
          entry.insertTextFormat === 2 ||
          (entry.textEdit !== undefined && target === undefined))
      ) {
        omitted = true;
        continue;
      }
      const insert = record(entry.textEdit) ? entry.textEdit.newText : entry.insertText;
      if (typeof insert === "string" && insert.length > 16384) {
        omitted = true;
        continue;
      }
      const parameters =
        feature === "signature" && Array.isArray(entry.parameters)
          ? entry.parameters.slice(0, 64).flatMap((parameter: unknown) => {
              if (!record(parameter)) return [];
              const label = parameter.label;
              return typeof label === "string"
                ? [clean(label, 512)]
                : Array.isArray(label) &&
                    typeof label[0] === "number" &&
                    typeof label[1] === "number"
                  ? [name.slice(label[0], label[1]).slice(0, 512)]
                  : [];
            })
          : undefined;
      output.push({
        label: clean(name, 512),
        ...(typeof insert === "string" ? { text: insert } : {}),
        detail: clean(
          [typeof entry.detail === "string" ? entry.detail : "", docs(entry.documentation)]
            .filter(Boolean)
            .join("\n\n"),
        ),
        ...(typeof entry.kind === "number" &&
        Number.isInteger(entry.kind) &&
        entry.kind >= 1 &&
        entry.kind <= 26
          ? { kind: entry.kind }
          : {}),
        ...(target === undefined ? {} : { range: target }),
        ...(parameters === undefined ? {} : { parameters }),
      });
      if (feature === "symbols" && Array.isArray(entry.children)) visit(entry.children, depth + 1);
    }
  };
  visit(candidates, 0);
  return {
    items: output,
    truncated: omitted || (record(value) && value.isIncomplete === true),
    ...(feature === "signature" &&
    record(value) &&
    typeof value.activeSignature === "number" &&
    Number.isInteger(value.activeSignature) &&
    value.activeSignature >= 0 &&
    value.activeSignature < output.length
      ? { activeSignature: value.activeSignature }
      : {}),
    ...(feature === "signature" &&
    record(value) &&
    typeof value.activeParameter === "number" &&
    Number.isInteger(value.activeParameter) &&
    value.activeParameter >= 0 &&
    value.activeParameter < 64
      ? { activeParameter: value.activeParameter }
      : {}),
  };
}
