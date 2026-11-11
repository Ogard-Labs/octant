import { installMonacoIntelligence } from "./monacoIntelligence";
import * as monaco from "monaco-editor";
import type {
  MonacoAdapterRuntime,
  MonacoAdapterSession,
  MonacoDebugDecorations,
  MonacoDefinitionLink,
  MonacoDiffRuntime,
  MonacoDiffSession,
  MonacoEditorMarker,
  MonacoLanguageBridge,
} from "./MonacoEditorAdapter";
import { installNativeEditorMenu } from "./nativeEditorMenu";
import { installMonacoEnvironment } from "./monacoEnvironment";
import {
  SCROLLBAR_LANE_WIDTH,
  SCROLLBAR_THUMB_WIDTH,
  systemFloatsScrollbars,
} from "./scrollbarTreatment";
import {
  DEFAULT_EDITOR_TYPOGRAPHY,
  type EditorTypographyProjection,
} from "@octant/theme/typography";
import { DEFAULT_EDITOR_COLORS, type EditorColorProjection } from "@octant/theme/editor-colors";

interface ModelLease {
  readonly disposeWhenUnused: boolean;
  readonly model: monaco.editor.ITextModel;
  controlledUpdateDepth: number;
  references: number;
}

const modelLeases = new Map<string, ModelLease>();

export const mount: MonacoAdapterRuntime["mount"] = (element, options) => {
  installMonacoEnvironment();
  installLanguageBridging();
  const uri = monaco.Uri.parse(options.modelUri, true);
  if (!["octant-code", "octant-text"].includes(uri.scheme))
    throw new Error("Monaco model URI must be Octant-owned.");
  const key = uri.toString();
  const lease = acquireModelLease(key, uri, options.value, options.language);
  setControlledValue(lease, options.value);
  const typography = options.typography ?? DEFAULT_EDITOR_TYPOGRAPHY;
  applyEditorColors(options.colors ?? DEFAULT_EDITOR_COLORS);
  const editor = monaco.editor.create(element, {
    automaticLayout: true,
    model: lease.model,
    readOnly: options.readOnly,
    // Monaco draws no error squiggles in a read-only editor by default, which
    // hid every diagnostic from a Plan thread (observed in rendered QA).
    renderValidationDecorations: "on",
    fontFamily: typography.fontFamily,
    fontSize: typography.fontSize,
    fontWeight: `${typography.fontWeight}`,
    lineHeight: typography.lineHeight,
    fontLigatures: typography.fontLigatures,
    minimap: { enabled: false },
    ...editorScrollbarOptions(),
    glyphMargin: options.onToggleBreakpoint !== undefined,
    theme: OCTANT_EDITOR_THEME,
  });
  if (options.viewState !== undefined) {
    editor.setPosition(lease.model.validatePosition(options.viewState));
    editor.setScrollPosition({
      scrollTop: options.viewState.scrollTop,
      scrollLeft: options.viewState.scrollLeft,
    });
  }
  const reportView = () => {
    const position = editor.getPosition();
    if (position !== null)
      options.onViewState?.({
        lineNumber: position.lineNumber,
        column: position.column,
        scrollTop: editor.getScrollTop(),
        scrollLeft: editor.getScrollLeft(),
      });
  };
  const viewScroll =
    options.onViewState === undefined ? undefined : editor.onDidScrollChange(reportView);
  const viewCursor =
    options.onViewState === undefined ? undefined : editor.onDidChangeCursorPosition(reportView);
  const disposeMenu = installNativeEditorMenu(editor);
  const debugDecorations = editor.createDecorationsCollection();
  const disposeGutter =
    options.onToggleBreakpoint === undefined
      ? undefined
      : installBreakpointGutter(editor, options.onToggleBreakpoint);
  const change = lease.model.onDidChangeContent(() => {
    if (lease.controlledUpdateDepth === 0) options.onChange(lease.model.getValue(undefined, true));
  });
  const bridge = options.languageBridge;
  if (bridge !== undefined) {
    editorBridges.set(editor, bridge);
    modelBridges.set(key, [...(modelBridges.get(key) ?? []), bridge]);
  }
  const cursor =
    options.onCursorPosition === undefined
      ? undefined
      : editor.onDidChangeCursorPosition((event) => options.onCursorPosition?.(event.position));
  const initialPosition = options.onCursorPosition === undefined ? undefined : editor.getPosition();
  if (initialPosition !== undefined && initialPosition !== null)
    options.onCursorPosition?.(initialPosition);
  // Keep Monaco's own single-file Shift+F12 references action untouched.
  const references =
    options.onReferences === undefined
      ? undefined
      : editor.addAction({
          id: "octant.language.checkout-references",
          label: "Find references in checkout",
          keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.F12],
          contextMenuGroupId: "navigation",
          contextMenuOrder: 2,
          run: (target) => {
            const position = target.getPosition();
            if (position !== null) options.onReferences?.(position);
          },
        });
  let disposed = false;

  return {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      reportView();
      viewScroll?.dispose();
      viewCursor?.dispose();
      disposeMenu();
      disposeGutter?.();
      cursor?.dispose();
      references?.dispose();
      debugDecorations.clear();
      change.dispose();
      if (bridge !== undefined) {
        editorBridges.delete(editor);
        const remaining = (modelBridges.get(key) ?? []).filter((entry) => entry !== bridge);
        if (remaining.length === 0) modelBridges.delete(key);
        else modelBridges.set(key, remaining);
      }
      editor.dispose();
      // The last editor on a model takes the server's markers with it; the
      // model itself may outlive it as another surface's model.
      if (lease.references === 1) setLanguageMarkers(lease.model, key, undefined);
      releaseModelLease(key, lease);
    },
    selection: () => {
      const range = editor.getSelection();
      if (range === null || range.isEmpty()) return undefined;
      const bom = lease.model.getValue(undefined, true).startsWith("\ufeff") ? 1 : 0;
      return {
        text: lease.model.getValueInRange(range),
        range,
        startOffset: bom + lease.model.getOffsetAt(range.getStartPosition()),
        endOffset: bom + lease.model.getOffsetAt(range.getEndPosition()),
      };
    },
    focus: () => editor.focus(),
    setReadOnly: (readOnly) => editor.updateOptions({ readOnly }),
    command: async (id) => {
      const action = editor.getAction(id);
      if (action === null || !action.isSupported()) throw new Error("unsupported");
      editor.focus();
      await action.run();
    },
    setPreferences: (preferences) => {
      editor.updateOptions({
        wordWrap: preferences.wordWrap,
        renderWhitespace: preferences.renderWhitespace,
        minimap: { enabled: preferences.minimap },
      });
      lease.model.updateOptions({
        tabSize: preferences.tabSize,
        insertSpaces: preferences.insertSpaces,
      });
    },
    setTypography: (next) => updateEditorTypography(editor, next),
    setColors: applyEditorColors,
    setValue: (value) => setControlledValue(lease, value),
    setLanguageMarkers: (markers) => setLanguageMarkers(lease.model, key, markers),
    revealRange: (range) => {
      editor.setSelection(range);
      editor.revealRangeInCenterIfOutsideViewport(range);
    },
    setDebugDecorations: (decorations) => debugDecorations.set(debugDecorationsFor(decorations)),
  } satisfies MonacoAdapterSession;
};

/**
 * Breakpoints are toggled from the glyph gutter with the pointer, and from
 * the keyboard with F9 on the cursor's line, so the gutter is never the only
 * way to set one.
 */
function installBreakpointGutter(
  editor: monaco.editor.IStandaloneCodeEditor,
  toggle: (lineNumber: number) => void,
): () => void {
  const mouse = editor.onMouseDown((event) => {
    if (event.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
    const lineNumber = event.target.position?.lineNumber;
    if (lineNumber !== undefined) toggle(lineNumber);
  });
  const action = editor.addAction({
    id: "octant.debug.toggle-breakpoint",
    label: "Toggle breakpoint",
    keybindings: [monaco.KeyCode.F9],
    run: (target) => {
      const lineNumber = target.getPosition()?.lineNumber;
      if (lineNumber !== undefined) toggle(lineNumber);
    },
  });
  return () => {
    mouse.dispose();
    action.dispose();
  };
}

function debugDecorationsFor(
  decorations: MonacoDebugDecorations,
): monaco.editor.IModelDeltaDecoration[] {
  const breakpoints = decorations.breakpoints.map((line) => ({
    range: new monaco.Range(line, 1, line, 1),
    options: {
      glyphMarginClassName: "code-debug-breakpoint",
      glyphMarginHoverMessage: { value: "Breakpoint" },
      stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
    },
  }));
  breakpoints.push(
    ...(decorations.unresolvedBreakpoints ?? []).map((line) => ({
      range: new monaco.Range(line, 1, line, 1),
      options: {
        glyphMarginClassName: "code-debug-breakpoint-unresolved",
        glyphMarginHoverMessage: { value: "Unresolved breakpoint; review in Run and debug" },
        stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
      },
    })),
  );
  const stopped = decorations.stoppedLine;
  return stopped === undefined
    ? breakpoints
    : [
        ...breakpoints,
        {
          range: new monaco.Range(stopped, 1, stopped, 1),
          options: {
            isWholeLine: true,
            className: "code-debug-stopped-line",
            glyphMarginClassName: "code-debug-stopped",
            glyphMarginHoverMessage: { value: "The program is stopped here" },
          },
        },
      ];
}

/** The owner of the markers the host's language server reports. */
const LANGUAGE_MARKER_OWNER = "octant-language";
/** Monaco's TypeScript worker reports under the model's language. */
const WORKER_MARKER_OWNERS: ReadonlyArray<string> = ["typescript", "javascript"];
/** The languages Monaco's own worker serves, which a host server may also serve. */
const BRIDGED_LANGUAGES = ["typescript", "javascript"];
/**
 * A definition elsewhere is handed to Monaco under this scheme, never as a
 * model of its own: the editor opener turns it back into a request to the
 * pane, which opens the file through the ordinary file-open path.
 */
const DEFINITION_LINK_SCHEME = "octant-code-definition";

const editorBridges = new WeakMap<monaco.editor.ICodeEditor, MonacoLanguageBridge>();
const modelBridges = new Map<string, ReadonlyArray<MonacoLanguageBridge>>();
/** Models whose diagnostics are the host server's alone. */
const servedModels = new Set<string>();
/**
 * One definition provider and editor opener serve every editor for the life
 * of the page, as Monaco's own language features do. Installed before the
 * first model exists, because Monaco's TypeScript worker registers its
 * providers when the first model of its language appears.
 */
let languageBridgingInstalled = false;

function installLanguageBridging(): void {
  if (languageBridgingInstalled) return;
  languageBridgingInstalled = true;
  installMonacoIntelligence((uri) => modelBridges.get(uri)?.at(-1));
  // Monaco merges every provider's definitions. The worker reads one file, so
  // on a file a server serves its guess (an import's own binding) sat beside
  // the server's location and turned each jump into a two-entry peek
  // (observed in rendered QA). Its provider is turned off, and the one below
  // asks the worker itself for files no server serves.
  for (const defaults of [
    monaco.typescript.typescriptDefaults,
    monaco.typescript.javascriptDefaults,
  ]) {
    defaults.setModeConfiguration({ ...defaults.modeConfiguration, definitions: false });
  }
  monaco.languages.registerDefinitionProvider(BRIDGED_LANGUAGES, {
    provideDefinition: async (model, position, token) => {
      const bridge = modelBridges.get(model.uri.toString())?.at(-1);
      const links = await bridge?.definitions({
        lineNumber: position.lineNumber,
        column: position.column,
      });
      if (token.isCancellationRequested) return null;
      if (links === undefined) return workerDefinitions(model, position);
      return links.map((link) => ({
        uri: link.kind === "this-file" ? model.uri : definitionLinkUri(link),
        range: link.kind === "outside" ? new monaco.Range(1, 1, 1, 1) : link.range,
      }));
    },
  });
  monaco.editor.registerEditorOpener({
    openCodeEditor: (source, resource, selectionOrPosition) => {
      if (resource.scheme !== DEFINITION_LINK_SCHEME) return false;
      const bridge = editorBridges.get(source);
      const link = parseDefinitionLink(resource, selectionOrPosition);
      if (bridge !== undefined && link !== undefined) bridge.open(link);
      return true;
    },
  });
}

/**
 * Definitions from Monaco's own worker, for a file no language server
 * serves: places in this file only, as the worker knows no other file of the
 * checkout.
 */
async function workerDefinitions(
  model: monaco.editor.ITextModel,
  position: monaco.Position,
): Promise<monaco.languages.Location[]> {
  try {
    const getWorker =
      model.getLanguageId() === "javascript"
        ? monaco.typescript.getJavaScriptWorker
        : monaco.typescript.getTypeScriptWorker;
    const worker = await (await getWorker())(model.uri);
    const entries: ReadonlyArray<unknown> =
      (await worker.getDefinitionAtPosition(model.uri.toString(), model.getOffsetAt(position))) ??
      [];
    if (model.isDisposed()) return [];
    return entries.flatMap((entry) => {
      if (
        !isRecord(entry) ||
        entry.fileName !== model.uri.toString() ||
        !isRecord(entry.textSpan) ||
        typeof entry.textSpan.start !== "number" ||
        typeof entry.textSpan.length !== "number"
      ) {
        return [];
      }
      const start = model.getPositionAt(entry.textSpan.start);
      const end = model.getPositionAt(entry.textSpan.start + entry.textSpan.length);
      return [
        {
          uri: model.uri,
          range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column),
        },
      ];
    });
  } catch {
    return [];
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

let markerWatchInstalled = false;

/**
 * The worker revalidates a model on every edit and would put its own
 * single-file errors back beside the server's, so a served model's are
 * cleared again each time they change.
 */
function installMarkerWatch(): void {
  if (markerWatchInstalled) return;
  markerWatchInstalled = true;
  monaco.editor.onDidChangeMarkers((uris) => {
    for (const uri of uris) {
      if (!servedModels.has(uri.toString())) continue;
      const model = monaco.editor.getModel(uri);
      if (model !== null) clearWorkerMarkers(model);
    }
  });
}

function setLanguageMarkers(
  model: monaco.editor.ITextModel,
  key: string,
  markers: ReadonlyArray<MonacoEditorMarker> | undefined,
): void {
  if (markers === undefined) {
    if (!servedModels.delete(key)) return;
    monaco.editor.setModelMarkers(model, LANGUAGE_MARKER_OWNER, []);
    return;
  }
  installMarkerWatch();
  servedModels.add(key);
  clearWorkerMarkers(model);
  monaco.editor.setModelMarkers(
    model,
    LANGUAGE_MARKER_OWNER,
    markers.map((marker) => ({
      ...marker.range,
      severity: markerSeverity(marker.severity),
      message: marker.message,
      source: marker.source,
    })),
  );
}

function markerSeverity(severity: MonacoEditorMarker["severity"]): monaco.MarkerSeverity {
  switch (severity) {
    case "error":
      return monaco.MarkerSeverity.Error;
    case "warning":
      return monaco.MarkerSeverity.Warning;
    case "information":
      return monaco.MarkerSeverity.Info;
    case "hint":
      return monaco.MarkerSeverity.Hint;
  }
}

function clearWorkerMarkers(model: monaco.editor.ITextModel): void {
  for (const owner of WORKER_MARKER_OWNERS) {
    if (monaco.editor.getModelMarkers({ owner, resource: model.uri }).length > 0) {
      monaco.editor.setModelMarkers(model, owner, []);
    }
  }
}

/** Placeholder models for definition links, oldest first. */
const linkModels = new Map<string, monaco.editor.ITextModel>();
const MAX_LINK_MODELS = 32;

function definitionLinkUri(
  link: Exclude<MonacoDefinitionLink, { readonly kind: "this-file" }>,
): monaco.Uri {
  const uri =
    link.kind === "outside"
      ? monaco.Uri.from({ scheme: DEFINITION_LINK_SCHEME, path: `/outside/${link.label}` })
      : monaco.Uri.from({ scheme: DEFINITION_LINK_SCHEME, path: `/file/${link.path}` });
  // Holding Cmd or Ctrl over a definition makes Monaco look up the target's
  // model for a preview, and a link with no model threw "Model not found"
  // into the page (observed in rendered QA). An empty placeholder answers
  // that lookup with nothing to preview; the file's text never enters it.
  const key = uri.toString();
  if (!linkModels.has(key) && monaco.editor.getModel(uri) === null) {
    linkModels.set(key, monaco.editor.createModel("", "plaintext", uri));
    for (const [oldest, model] of linkModels) {
      if (linkModels.size <= MAX_LINK_MODELS) break;
      linkModels.delete(oldest);
      model.dispose();
    }
  }
  return uri;
}

function parseDefinitionLink(
  resource: monaco.Uri,
  selectionOrPosition: monaco.IRange | monaco.IPosition | undefined,
): Exclude<MonacoDefinitionLink, { readonly kind: "this-file" }> | undefined {
  if (resource.path === "/outside/bundled-library") {
    return { kind: "outside", label: "bundled-library" };
  }
  if (resource.path === "/outside/elsewhere") return { kind: "outside", label: "elsewhere" };
  if (!resource.path.startsWith("/file/")) return undefined;
  const path = resource.path.slice("/file/".length);
  if (path.length === 0) return undefined;
  const range =
    selectionOrPosition === undefined
      ? new monaco.Range(1, 1, 1, 1)
      : "startLineNumber" in selectionOrPosition
        ? selectionOrPosition
        : new monaco.Range(
            selectionOrPosition.lineNumber,
            selectionOrPosition.column,
            selectionOrPosition.lineNumber,
            selectionOrPosition.column,
          );
  return {
    kind: "other-file",
    path,
    range: {
      startLineNumber: range.startLineNumber,
      startColumn: range.startColumn,
      endLineNumber: range.endLineNumber,
      endColumn: range.endColumn,
    },
  };
}

/**
 * A two-sided comparison of one file. The models are owned by this session
 * rather than leased: a diff side is derived evidence, never the editable
 * document a lease exists to keep single-instanced.
 */
export const mountDiff: MonacoDiffRuntime["mountDiff"] = (element, options) => {
  installMonacoEnvironment();
  installLanguageBridging();
  const base = monaco.Uri.parse(options.modelUriBase, true);
  if (base.scheme !== "octant-code") throw new Error("Monaco model URI must be Octant-owned.");
  const typography = options.typography ?? DEFAULT_EDITOR_TYPOGRAPHY;
  applyEditorColors(options.colors ?? DEFAULT_EDITOR_COLORS);
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
    ...(options.ignoreTrimWhitespace === undefined
      ? {}
      : { ignoreTrimWhitespace: options.ignoreTrimWhitespace }),
    fontFamily: typography.fontFamily,
    fontSize: typography.fontSize,
    fontWeight: `${typography.fontWeight}`,
    lineHeight: typography.lineHeight,
    fontLigatures: typography.fontLigatures,
    minimap: { enabled: false },
    ...editorScrollbarOptions(),
    // The comparison kept a 30px strip down its right edge for a map of the
    // changes, painted whether or not anything scrolled. No pane keeps a
    // strip there; the changes stay marked on their lines and in the gutter.
    renderOverviewRuler: false,
    theme: OCTANT_EDITOR_THEME,
  });
  const viewModel = editor.createViewModel({ original, modified });
  editor.setModel(viewModel);
  const disposeOriginalMenu = installNativeEditorMenu(editor.getOriginalEditor());
  const disposeModifiedMenu = installNativeEditorMenu(editor.getModifiedEditor());
  const lineSelections =
    options.onSelectLine === undefined
      ? []
      : (["original", "modified"] as const).map((side) =>
          (side === "original"
            ? editor.getOriginalEditor()
            : editor.getModifiedEditor()
          ).onDidChangeCursorPosition((event) => {
            if (event.source === "keyboard" || event.source === "mouse")
              options.onSelectLine?.({ side, line: event.position.lineNumber });
          }),
        );
  let disposed = false;

  return {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      disposeOriginalMenu();
      disposeModifiedMenu();
      for (const selection of lineSelections) selection.dispose();
      // Monaco defers releasing its view model. Cancel its worker before the
      // text models disappear, including a comparison closed immediately.
      viewModel.dispose();
      editor.dispose();
      original.dispose();
      modified.dispose();
    },
    setRenderSideBySide: (sideBySide) => editor.updateOptions({ renderSideBySide: sideBySide }),
    setIgnoreTrimWhitespace: (ignore) => editor.updateOptions({ ignoreTrimWhitespace: ignore }),
    setColors: applyEditorColors,
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
      const viewState = editor.saveViewState();
      if (original.getValue(undefined, true) !== values.original)
        original.setValue(values.original);
      if (modified.getValue(undefined, true) !== values.modified)
        modified.setValue(values.modified);
      if (viewState !== null) editor.restoreViewState(viewState);
    },
  } satisfies MonacoDiffSession;
};

/**
 * Monaco draws its scrollbars itself, so the one scrollbar rule in styles.css
 * cannot reach them. These options ask it for the picture that rule draws in a
 * pane: the same thumb in the same lane, and nothing else painted at the edge.
 * Its colours travel with the theme below, and the thumb's round ends are in
 * styles/code.css, because Monaco has no option for them.
 */
function editorScrollbarOptions(): Pick<
  monaco.editor.IEditorOptions,
  "scrollbar" | "overviewRulerBorder" | "hideCursorInOverviewRuler"
> {
  // "auto" hides the thumb until the editor scrolls or the pointer is over
  // it, as a floating system thumb hides at rest. "visible" keeps it there
  // for as long as the text overflows, as a pane's stays in a system strip.
  // Read once per editor: one already open keeps what it was mounted with if
  // the system setting changes under it.
  const shown = systemFloatsScrollbars() ? "auto" : "visible";
  return {
    scrollbar: {
      vertical: shown,
      horizontal: shown,
      verticalScrollbarSize: SCROLLBAR_LANE_WIDTH,
      horizontalScrollbarSize: SCROLLBAR_LANE_WIDTH,
      verticalSliderSize: SCROLLBAR_THUMB_WIDTH,
      horizontalSliderSize: SCROLLBAR_THUMB_WIDTH,
      // Monaco shades the top edge once the text has scrolled. No pane does.
      useShadows: false,
    },
    // The ruler under the thumb still marks errors and search matches where
    // they are. Its outline was a hairline down the whole pane, 14px in from
    // the edge, and its cursor mark a dash beside it, both there at rest
    // (measured in a rendered editor).
    overviewRulerBorder: false,
    hideCursorInOverviewRuler: true,
  };
}

/**
 * Monaco keeps one theme for the whole page, so every editor and diff wears
 * the same one, and redefining it repaints all of them at once: that is how a
 * theme switched while files are open reaches them without a remount.
 */
const OCTANT_EDITOR_THEME = "octant";
let appliedEditorColors: EditorColorProjection | undefined;

function applyEditorColors(colors: EditorColorProjection): void {
  if (appliedEditorColors !== undefined && sameEditorColors(appliedEditorColors, colors)) return;
  appliedEditorColors = colors;
  monaco.editor.defineTheme(OCTANT_EDITOR_THEME, {
    base: colors.mode === "light" ? "vs" : "vs-dark",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": colors.background,
      "editor.foreground": colors.foreground,
      "editorGutter.background": colors.background,
      "editorLineNumber.foreground": colors.mutedForeground,
      "editorLineNumber.activeForeground": colors.foreground,
      "editorCursor.foreground": colors.foreground,
      "editor.selectionBackground": colors.selection,
      "editor.inactiveSelectionBackground": colors.selection,
      "editor.lineHighlightBackground": colors.background,
      "editor.lineHighlightBorder": colors.lineHighlightBorder,
      "editorIndentGuide.background1": colors.indentGuide,
      "editorIndentGuide.activeBackground1": colors.activeIndentGuide,
      "editorWidget.background": colors.widgetBackground,
      "editorWidget.foreground": colors.foreground,
      "editorWidget.border": colors.widgetBorder,
      "editorHoverWidget.background": colors.widgetBackground,
      "editorHoverWidget.border": colors.widgetBorder,
      "editorSuggestWidget.background": colors.widgetBackground,
      "editorSuggestWidget.border": colors.widgetBorder,
      "peekViewEditor.background": colors.widgetBackground,
      "peekViewResult.background": colors.widgetBackground,
      // Every scrollbar Monaco draws, its popups' included, takes the thumb.
      "scrollbarSlider.background": colors.scrollbarThumb,
      "scrollbarSlider.hoverBackground": colors.scrollbarThumbHover,
      "scrollbarSlider.activeBackground": colors.scrollbarThumbHover,
      focusBorder: colors.focusBorder,
      "editorError.foreground": colors.error,
      // A fifth of the role, not the role itself: diff text is read on it.
      "diffEditor.insertedTextBackground": `${colors.inserted}33`,
      "diffEditor.removedTextBackground": `${colors.removed}33`,
    },
  });
  monaco.editor.setTheme(OCTANT_EDITOR_THEME);
}

function sameEditorColors(left: EditorColorProjection, right: EditorColorProjection): boolean {
  return (Object.keys(left) as Array<keyof EditorColorProjection>).every(
    (key) => left[key] === right[key],
  );
}

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
  if (lease.model.getValue(undefined, true) === value) return;
  lease.controlledUpdateDepth += 1;
  try {
    lease.model.setValue(value);
  } finally {
    lease.controlledUpdateDepth -= 1;
  }
}
