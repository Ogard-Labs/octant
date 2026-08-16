import CssWorker from "monaco-editor/language/css/css.worker.js?worker";
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";
import HtmlWorker from "monaco-editor/language/html/html.worker.js?worker";
import JsonWorker from "monaco-editor/language/json/json.worker.js?worker";
import TypeScriptWorker from "monaco-editor/language/typescript/ts.worker.js?worker";

export type MonacoWorkerKind = "css" | "editor" | "html" | "json" | "typescript";

export type MonacoWorkerFactories = Readonly<Record<MonacoWorkerKind, () => Worker>>;

export interface MonacoEnvironmentTarget {
  MonacoEnvironment?: unknown;
}

const liveWorkerFactories: MonacoWorkerFactories = {
  css: () => new CssWorker(),
  editor: () => new EditorWorker(),
  html: () => new HtmlWorker(),
  json: () => new JsonWorker(),
  typescript: () => new TypeScriptWorker(),
};

export function monacoWorkerKindForLabel(label: string): MonacoWorkerKind {
  if (label === "json") return "json";
  if (label === "css" || label === "scss" || label === "less") return "css";
  if (label === "html" || label === "handlebars" || label === "razor") return "html";
  if (label === "typescript" || label === "javascript") return "typescript";
  return "editor";
}

export function createMonacoEnvironment(factories: MonacoWorkerFactories) {
  return {
    getWorker: (_moduleId: string, label: string) => factories[monacoWorkerKindForLabel(label)](),
  };
}

export function installMonacoEnvironment(
  target: MonacoEnvironmentTarget = globalThis,
  factories: MonacoWorkerFactories = liveWorkerFactories,
): void {
  target.MonacoEnvironment = createMonacoEnvironment(factories);
}
