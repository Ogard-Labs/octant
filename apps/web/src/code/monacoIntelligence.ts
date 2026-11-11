import * as monaco from "monaco-editor";
import type { CodeIntelligenceFeature } from "@octant/contracts/code-language";
import type { MonacoLanguageBridge } from "./MonacoEditorAdapter";
import { toEditorRange } from "./codeLanguageEditor";

/** Registrations live with Monaco; each request still belongs to its exact current model. */
export function installMonacoIntelligence(
  bridgeFor: (uri: string) => MonacoLanguageBridge | undefined,
): void {
  const selector = { scheme: "octant-code" };
  const query = async (
    model: monaco.editor.ITextModel,
    position: monaco.IPosition,
    feature: CodeIntelligenceFeature,
    token: monaco.CancellationToken,
    formatting?: { readonly tabSize: number; readonly insertSpaces: boolean },
  ) => {
    const version = model.getVersionId();
    const bridge = bridgeFor(model.uri.toString());
    const answer = await bridge?.intelligence?.(position, feature, formatting);
    return token.isCancellationRequested ||
      model.isDisposed() ||
      model.getVersionId() !== version ||
      bridgeFor(model.uri.toString()) !== bridge
      ? undefined
      : answer;
  };
  monaco.languages.registerCompletionItemProvider(selector, {
    triggerCharacters: [".", '"', "'", "/", "@"],
    provideCompletionItems: async (model, position, _context, token) => {
      const answer = await query(model, position, "completion", token);
      if (answer === undefined) return undefined;
      const word = model.getWordUntilPosition(position);
      return {
        incomplete: answer.truncated,
        suggestions: answer.items.flatMap((item) => {
          const range =
            item.range === undefined
              ? new monaco.Range(
                  position.lineNumber,
                  word.startColumn,
                  position.lineNumber,
                  word.endColumn,
                )
              : toEditorRange(item.range);
          if (!monaco.Range.equalsRange(model.validateRange(range), range)) return [];
          return [
            {
              label: item.label,
              insertText: item.text ?? item.label,
              ...(item.detail === undefined ? {} : { detail: item.detail }),
              kind: completionKind(item.kind),
              range,
            },
          ];
        }),
      };
    },
  });
  monaco.languages.registerHoverProvider(selector, {
    provideHover: async (model, position, token) => {
      const answer = await query(model, position, "hover", token);
      return answer === undefined || answer.items.length === 0
        ? undefined
        : {
            contents: answer.items.map((item) => ({
              value: escapeMarkdown(item.text ?? item.label),
              isTrusted: false,
              supportHtml: false,
            })),
          };
    },
  });
  monaco.languages.registerSignatureHelpProvider(selector, {
    signatureHelpTriggerCharacters: ["(", ","],
    signatureHelpRetriggerCharacters: [")"],
    provideSignatureHelp: async (model, position, token) => {
      const answer = await query(model, position, "signature", token);
      if (answer === undefined || answer.items.length === 0) return undefined;
      return {
        value: {
          activeSignature: answer.activeSignature ?? 0,
          activeParameter: answer.activeParameter ?? 0,
          signatures: answer.items.map((item) => ({
            label: item.label,
            ...(item.detail === undefined ? {} : { documentation: item.detail }),
            parameters: (item.parameters ?? []).map((label) => ({ label })),
          })),
        },
        dispose: () => undefined,
      };
    },
  });
  monaco.languages.registerDocumentSymbolProvider(selector, {
    provideDocumentSymbols: async (model, token) => {
      const answer = await query(model, new monaco.Position(1, 1), "symbols", token);
      return answer?.items.flatMap((item) =>
        item.range === undefined
          ? []
          : [
              {
                name: item.label,
                detail: item.detail ?? "",
                kind: symbolKind(item.kind),
                range: toEditorRange(item.range),
                selectionRange: toEditorRange(item.range),
                tags: [],
              },
            ],
      );
    },
  });
  monaco.languages.registerDocumentFormattingEditProvider(selector, {
    provideDocumentFormattingEdits: async (model, options, token) => {
      const answer = await query(model, new monaco.Position(1, 1), "formatting", token, {
        tabSize: options.tabSize,
        insertSpaces: options.insertSpaces,
      });
      if (answer === undefined || answer.truncated) return undefined;
      const edits = answer.items.flatMap((item) =>
        item.range === undefined || item.text === undefined
          ? []
          : [{ range: toEditorRange(item.range), text: item.text }],
      );
      if (
        edits.length !== answer.items.length ||
        edits.some((edit) => !monaco.Range.equalsRange(model.validateRange(edit.range), edit.range))
      )
        return undefined;
      const ordered = [...edits].sort((a, b) =>
        monaco.Range.compareRangesUsingStarts(a.range, b.range),
      );
      if (
        ordered.some(
          (edit, index) =>
            index > 0 &&
            monaco.Range.areIntersecting(ordered[index - 1]?.range ?? edit.range, edit.range),
        )
      )
        return undefined;
      return edits;
    },
  });
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}[\]()<>#+.!|~-]/g, "\\$&");
}

function completionKind(kind: number | undefined): monaco.languages.CompletionItemKind {
  const k = monaco.languages.CompletionItemKind;
  const kinds = [
    k.Text,
    k.Method,
    k.Function,
    k.Constructor,
    k.Field,
    k.Variable,
    k.Class,
    k.Interface,
    k.Module,
    k.Property,
    k.Unit,
    k.Value,
    k.Enum,
    k.Keyword,
    k.Snippet,
    k.Color,
    k.File,
    k.Reference,
    k.Folder,
    k.EnumMember,
    k.Constant,
    k.Struct,
    k.Event,
    k.Operator,
    k.TypeParameter,
  ];
  return kinds[(kind ?? 1) - 1] ?? k.Text;
}
function symbolKind(kind: number | undefined): monaco.languages.SymbolKind {
  const k = monaco.languages.SymbolKind;
  const kinds = [
    k.File,
    k.Module,
    k.Namespace,
    k.Package,
    k.Class,
    k.Method,
    k.Property,
    k.Field,
    k.Constructor,
    k.Enum,
    k.Interface,
    k.Function,
    k.Variable,
    k.Constant,
    k.String,
    k.Number,
    k.Boolean,
    k.Array,
    k.Object,
    k.Key,
    k.Null,
    k.EnumMember,
    k.Struct,
    k.Event,
    k.Operator,
    k.TypeParameter,
  ];
  return kinds[(kind ?? 13) - 1] ?? k.Variable;
}
