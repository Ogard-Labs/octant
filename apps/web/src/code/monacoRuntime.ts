import * as monaco from "monaco-editor";
import type {
  MonacoAdapterRuntime,
  MonacoAdapterSession,
  MonacoDiffRuntime,
  MonacoDiffSession,
} from "./MonacoEditorAdapter";
import { installMonacoEnvironment } from "./monacoEnvironment";
import {
  DEFAULT_EDITOR_TYPOGRAPHY,
  type EditorTypographyProjection,
} from "@octant/theme/typography";

interface ModelLease {
  readonly disposeWhenUnused: boolean;
  readonly model: monaco.editor.ITextModel;
  controlledUpdateDepth: number;
  references: number;
}

const modelLeases = new Map<string, ModelLease>();

export const mount: MonacoAdapterRuntime["mount"] = (element, options) => {
  installMonacoEnvironment();
  const uri = monaco.Uri.parse(options.modelUri, true);
  if (uri.scheme !== "octant-code") throw new Error("Monaco model URI must be Octant-owned.");
  const key = uri.toString();
  const lease = acquireModelLease(key, uri, options.value, options.language);
  setControlledValue(lease, options.value);
  const typography = options.typography ?? DEFAULT_EDITOR_TYPOGRAPHY;
  const editor = monaco.editor.create(element, {
    automaticLayout: true,
    model: lease.model,
    readOnly: options.readOnly,
    fontFamily: typography.fontFamily,
    fontSize: typography.fontSize,
    fontWeight: `${typography.fontWeight}`,
    lineHeight: typography.lineHeight,
    fontLigatures: typography.fontLigatures,
    minimap: { enabled: false },
    theme: "vs-dark",
  });
  const change = lease.model.onDidChangeContent(() => {
    if (lease.controlledUpdateDepth === 0) options.onChange(lease.model.getValue());
  });
  let disposed = false;

  return {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      change.dispose();
      editor.dispose();
      releaseModelLease(key, lease);
    },
    focus: () => editor.focus(),
    setReadOnly: (readOnly) => editor.updateOptions({ readOnly }),
    setTypography: (next) => updateEditorTypography(editor, next),
    setValue: (value) => setControlledValue(lease, value),
  } satisfies MonacoAdapterSession;
};

/**
 * A two-sided comparison of one file. The models are owned by this session
 * rather than leased: a diff side is derived evidence, never the editable
 * document a lease exists to keep single-instanced.
 */
export const mountDiff: MonacoDiffRuntime["mountDiff"] = (element, options) => {
  installMonacoEnvironment();
  const base = monaco.Uri.parse(options.modelUriBase, true);
  if (base.scheme !== "octant-code") throw new Error("Monaco model URI must be Octant-owned.");
  const typography = options.typography ?? DEFAULT_EDITOR_TYPOGRAPHY;
  const original = monaco.editor.createModel(
    options.original,
    options.language,
    base.with({ path: `${base.path}/original` }),
  );
  const modified = monaco.editor.createModel(
    options.modified,
    options.language,
    base.with({ path: `${base.path}/modified` }),
  );
  const editor = monaco.editor.createDiffEditor(element, {
    automaticLayout: true,
    readOnly: true,
    originalEditable: false,
    renderSideBySide: options.renderSideBySide,
    fontFamily: typography.fontFamily,
    fontSize: typography.fontSize,
    fontWeight: `${typography.fontWeight}`,
    lineHeight: typography.lineHeight,
    fontLigatures: typography.fontLigatures,
    minimap: { enabled: false },
    theme: "vs-dark",
  });
  editor.setModel({ original, modified });
  let disposed = false;

  return {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      editor.dispose();
      original.dispose();
      modified.dispose();
    },
    setRenderSideBySide: (sideBySide) => editor.updateOptions({ renderSideBySide: sideBySide }),
    setTypography: (next) => {
      editor.updateOptions({
        fontFamily: next.fontFamily,
        fontSize: next.fontSize,
        fontWeight: `${next.fontWeight}`,
        lineHeight: next.lineHeight,
        fontLigatures: next.fontLigatures,
      });
    },
    setValues: (values) => {
      if (original.getValue() !== values.original) original.setValue(values.original);
      if (modified.getValue() !== values.modified) modified.setValue(values.modified);
    },
  } satisfies MonacoDiffSession;
};

function updateEditorTypography(
  editor: monaco.editor.IStandaloneCodeEditor,
  typography: EditorTypographyProjection,
): void {
  editor.updateOptions({
    fontFamily: typography.fontFamily,
    fontSize: typography.fontSize,
    fontWeight: `${typography.fontWeight}`,
    lineHeight: typography.lineHeight,
    fontLigatures: typography.fontLigatures,
  });
}

function acquireModelLease(
  key: string,
  uri: monaco.Uri,
  value: string,
  language: string,
): ModelLease {
  const active = modelLeases.get(key);
  if (active !== undefined) {
    active.references += 1;
    return active;
  }
  const existing = monaco.editor.getModel(uri);
  const lease: ModelLease = {
    controlledUpdateDepth: 0,
    disposeWhenUnused: existing === null,
    model: existing ?? monaco.editor.createModel(value, language, uri),
    references: 1,
  };
  modelLeases.set(key, lease);
  return lease;
}

function releaseModelLease(key: string, lease: ModelLease): void {
  lease.references -= 1;
  if (lease.references > 0) return;
  modelLeases.delete(key);
  if (lease.disposeWhenUnused) lease.model.dispose();
}

function setControlledValue(lease: ModelLease, value: string): void {
  if (lease.model.getValue() === value) return;
  lease.controlledUpdateDepth += 1;
  try {
    lease.model.setValue(value);
  } finally {
    lease.controlledUpdateDepth -= 1;
  }
}
