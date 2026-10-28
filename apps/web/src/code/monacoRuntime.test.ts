import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  changeListeners: [] as Array<() => void>,
  changeDispose: vi.fn(),
  createModel: vi.fn(),
  editorDispose: vi.fn(),
  editorCreate: vi.fn(),
  editorFocus: vi.fn(),
  editorUpdateOptions: vi.fn(),
  getModel: vi.fn(),
  installEnvironment: vi.fn(),
  model: undefined as unknown as {
    uri: { scheme: string; toString: () => string };
    getLanguageId: () => string;
    getOffsetAt: () => number;
    getPositionAt: (offset: number) => { lineNumber: number; column: number };
    isDisposed: () => boolean;
    dispose: () => void;
    getValue: () => string;
    onDidChangeContent: (listener: () => void) => { dispose: () => void };
    setValue: (value: string) => void;
  },
  modelDispose: vi.fn(),
  modelGetValue: vi.fn(),
  modelSetValue: vi.fn(),
  value: "stale",
  markers: new Map<string, ReadonlyArray<unknown>>(),
  setModelMarkers: vi.fn(),
  markerListeners: [] as Array<(uris: ReadonlyArray<{ toString(): string }>) => void>,
  definitionProviders: [] as Array<{
    provideDefinition: (
      model: unknown,
      position: { lineNumber: number; column: number },
      token: { isCancellationRequested: boolean },
    ) => Promise<ReadonlyArray<{ uri: { scheme: string; path: string }; range: unknown }> | null>;
  }>,
  openers: [] as Array<{
    openCodeEditor: (source: unknown, resource: unknown, selection?: unknown) => boolean;
  }>,
  editor: undefined as unknown,
  modeConfigurations: [] as Array<readonly [string, unknown]>,
  workerDefinitions: [] as ReadonlyArray<unknown>,
  decorationsSet: vi.fn(),
  defineTheme: vi.fn(),
  setTheme: vi.fn(),
  mouseDownListeners: [] as Array<
    (event: { target: { type: number; position?: { lineNumber: number } } }) => void
  >,
  actions: [] as Array<{
    id: string;
    keybindings?: ReadonlyArray<number>;
    run: (editor: { getPosition: () => { lineNumber: number } | null }) => void;
  }>,
}));

const modelUri = { scheme: "octant-code", toString: () => "octant-code://checkout/file" };

mocks.model = {
  uri: modelUri,
  getLanguageId: () => "typescript",
  getOffsetAt: () => 7,
  getPositionAt: (offset: number) => ({ lineNumber: 1, column: offset + 1 }),
  isDisposed: () => false,
  dispose: mocks.modelDispose,
  getValue: mocks.modelGetValue,
  onDidChangeContent: (listener) => {
    mocks.changeListeners.push(listener);
    return { dispose: mocks.changeDispose };
  },
  setValue: mocks.modelSetValue,
};

vi.mock("monaco-editor", () => ({
  Uri: {
    parse: vi.fn(() => modelUri),
    from: (parts: { scheme: string; path: string }) => parts,
  },
  Range: class {
    constructor(
      readonly startLineNumber: number,
      readonly startColumn: number,
      readonly endLineNumber: number,
      readonly endColumn: number,
    ) {}
  },
  MarkerSeverity: { Hint: 1, Info: 2, Warning: 4, Error: 8 },
  KeyCode: { F9: 67 },
  editor: {
    MouseTargetType: { GUTTER_GLYPH_MARGIN: 2, CONTENT_TEXT: 6 },
    TrackedRangeStickiness: { NeverGrowsWhenTypingAtEdges: 1 },
    create: mocks.editorCreate.mockImplementation(() => {
      mocks.editor = {
        dispose: mocks.editorDispose,
        focus: mocks.editorFocus,
        updateOptions: mocks.editorUpdateOptions,
        createDecorationsCollection: () => ({ set: mocks.decorationsSet, clear: vi.fn() }),
        onMouseDown: (listener: (typeof mocks.mouseDownListeners)[number]) => {
          mocks.mouseDownListeners.push(listener);
          return { dispose: vi.fn() };
        },
        addAction: (action: (typeof mocks.actions)[number]) => {
          mocks.actions.push(action);
          return { dispose: vi.fn() };
        },
      };
      return mocks.editor;
    }),
    createModel: mocks.createModel,
    defineTheme: mocks.defineTheme,
    setTheme: mocks.setTheme,
    getModel: mocks.getModel,
    getModelMarkers: ({ owner }: { owner: string }) => mocks.markers.get(owner) ?? [],
    setModelMarkers: mocks.setModelMarkers.mockImplementation(
      (_model: unknown, owner: string, markers: ReadonlyArray<unknown>) =>
        mocks.markers.set(owner, markers),
    ),
    onDidChangeMarkers: (listener: (typeof mocks.markerListeners)[number]) => {
      mocks.markerListeners.push(listener);
      return { dispose: vi.fn() };
    },
    registerEditorOpener: (opener: (typeof mocks.openers)[number]) => {
      mocks.openers.push(opener);
      return { dispose: vi.fn() };
    },
  },
  typescript: {
    typescriptDefaults: {
      modeConfiguration: { definitions: true, hovers: true },
      setModeConfiguration: (modes: unknown) =>
        mocks.modeConfigurations.push(["typescript", modes]),
    },
    javascriptDefaults: {
      modeConfiguration: { definitions: true, hovers: true },
      setModeConfiguration: (modes: unknown) =>
        mocks.modeConfigurations.push(["javascript", modes]),
    },
    getTypeScriptWorker: async () => async () => ({
      getDefinitionAtPosition: async () => mocks.workerDefinitions,
    }),
    getJavaScriptWorker: async () => async () => ({
      getDefinitionAtPosition: async () => mocks.workerDefinitions,
    }),
  },
  languages: {
    registerDefinitionProvider: (
      _languages: unknown,
      provider: (typeof mocks.definitionProviders)[number],
    ) => {
      mocks.definitionProviders.push(provider);
      return { dispose: vi.fn() };
    },
  },
}));

vi.mock("./monacoEnvironment", () => ({
  installMonacoEnvironment: mocks.installEnvironment,
}));

import { DEFAULT_DARK_TOKENS, DEFAULT_LIGHT_TOKENS } from "@octant/theme/tokens";
import { resolveEditorColorProjection } from "@octant/theme/editor-colors";
import { mount } from "./monacoRuntime";

describe("Monaco runtime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.changeListeners.length = 0;
    mocks.mouseDownListeners.length = 0;
    mocks.actions.length = 0;
    mocks.value = "stale";
    mocks.modelGetValue.mockImplementation(() => mocks.value);
    mocks.modelSetValue.mockImplementation((value: string) => {
      mocks.value = value;
      for (const listener of mocks.changeListeners) listener();
    });
    mocks.getModel.mockReturnValue(mocks.model);
    mocks.createModel.mockReturnValue(mocks.model);
  });

  it("synchronizes an existing opaque model to the latest authoritative value", () => {
    const session = mount(document.createElement("div"), {
      language: "markdown",
      modelUri: "octant-code://checkout-opaque/file-opaque",
      onChange: vi.fn(),
      readOnly: false,
      value: "latest",
    });

    expect(mocks.modelSetValue).toHaveBeenCalledWith("latest");
    session.dispose();
    expect(mocks.modelDispose).not.toHaveBeenCalled();
  });

  it("toggles a breakpoint from the glyph gutter or F9 only when the pane takes breakpoints, and draws them with the stopped line", () => {
    const plain = mount(document.createElement("div"), options());
    expect(mocks.editorCreate).toHaveBeenLastCalledWith(
      expect.any(HTMLElement),
      expect.objectContaining({ glyphMargin: false }),
    );
    expect(mocks.mouseDownListeners).toHaveLength(0);
    plain.dispose();

    const onToggleBreakpoint = vi.fn();
    const session = mount(document.createElement("div"), options({ onToggleBreakpoint }));
    expect(mocks.editorCreate).toHaveBeenLastCalledWith(
      expect.any(HTMLElement),
      expect.objectContaining({ glyphMargin: true }),
    );
    for (const listener of mocks.mouseDownListeners) {
      listener({ target: { type: 6, position: { lineNumber: 4 } } });
      listener({ target: { type: 2, position: { lineNumber: 3 } } });
    }
    expect(onToggleBreakpoint).toHaveBeenCalledExactlyOnceWith(3);
    const f9 = mocks.actions.find((action) => action.keybindings?.includes(67));
    f9?.run({ getPosition: () => ({ lineNumber: 7 }) });
    expect(onToggleBreakpoint).toHaveBeenLastCalledWith(7);

    session.setDebugDecorations?.({ breakpoints: [3], stoppedLine: 5 });
    expect(mocks.decorationsSet).toHaveBeenLastCalledWith([
      expect.objectContaining({
        range: expect.objectContaining({ startLineNumber: 3 }),
        options: expect.objectContaining({ glyphMarginClassName: "code-debug-breakpoint" }),
      }),
      expect.objectContaining({
        range: expect.objectContaining({ startLineNumber: 5 }),
        options: expect.objectContaining({
          isWholeLine: true,
          className: "code-debug-stopped-line",
        }),
      }),
    ]);
    session.dispose();
  });

  it("paints the editor in the app's light or dark theme and repaints it on a live switch", () => {
    const light = resolveEditorColorProjection({ mode: "light", tokens: DEFAULT_LIGHT_TOKENS });
    const dark = resolveEditorColorProjection({ mode: "dark", tokens: DEFAULT_DARK_TOKENS });
    const session = mount(document.createElement("div"), options({ colors: light }));

    expect(mocks.defineTheme).toHaveBeenLastCalledWith(
      "octant",
      expect.objectContaining({
        base: "vs",
        inherit: true,
        colors: expect.objectContaining({
          "editor.background": "#ffffff",
          "editor.foreground": "#141414",
        }),
      }),
    );
    expect(mocks.editorCreate).toHaveBeenCalledWith(
      expect.any(HTMLElement),
      expect.objectContaining({ theme: "octant", renderValidationDecorations: "on" }),
    );

    session.setColors?.(dark);
    expect(mocks.defineTheme).toHaveBeenLastCalledWith(
      "octant",
      expect.objectContaining({
        base: "vs-dark",
        colors: expect.objectContaining({ "editor.background": "#1a1a1a" }),
      }),
    );
    expect(mocks.setTheme).toHaveBeenLastCalledWith("octant");
    session.dispose();
  });

  it("projects editor typography at mount and on live updates", () => {
    const session = mount(
      document.createElement("div"),
      options({
        typography: {
          fontFamily: "Source Code Pro",
          fontSize: 15,
          fontWeight: 500,
          lineHeight: 1.8,
          fontLigatures: false,
        },
      }),
    );

    expect(mocks.editorCreate).toHaveBeenCalledWith(
      expect.any(HTMLElement),
      expect.objectContaining({
        fontFamily: "Source Code Pro",
        fontSize: 15,
        fontWeight: "500",
        lineHeight: 1.8,
        fontLigatures: false,
      }),
    );
    session.setTypography?.({
      fontFamily: "Fira Code",
      fontSize: 16,
      fontWeight: 600,
      lineHeight: 2,
      fontLigatures: true,
    });
    expect(mocks.editorUpdateOptions).toHaveBeenLastCalledWith({
      fontFamily: "Fira Code",
      fontSize: 16,
      fontWeight: "600",
      lineHeight: 2,
      fontLigatures: true,
    });
    session.dispose();
  });

  it("retains a shared model until every pane using its opaque URI is disposed", () => {
    mocks.getModel.mockReturnValueOnce(null);
    const first = mount(document.createElement("div"), options());
    const second = mount(document.createElement("div"), options());

    first.dispose();
    expect(mocks.modelDispose).not.toHaveBeenCalled();

    second.dispose();
    expect(mocks.modelDispose).toHaveBeenCalledOnce();
  });

  it("does not report controlled values as user edits", () => {
    const onChange = vi.fn();
    const session = mount(document.createElement("div"), options({ onChange }));

    onChange.mockClear();
    session.setValue("authoritative");
    expect(onChange).not.toHaveBeenCalled();

    mocks.value = "user edit";
    for (const listener of mocks.changeListeners) listener();
    expect(onChange).toHaveBeenCalledWith("user edit");
    session.dispose();
  });

  it("shows only the server's diagnostics on a model it serves, and lets the worker's back when it stops", () => {
    mocks.markers.clear();
    const session = mount(document.createElement("div"), options({ language: "typescript" }));
    mocks.markers.set("typescript", [{ message: "single-file guess" }]);

    session.setLanguageMarkers?.([
      {
        range: { startLineNumber: 2, startColumn: 14, endLineNumber: 2, endColumn: 19 },
        severity: "error",
        message: "Type 'string' is not assignable to type 'number'.",
        source: "typescript",
      },
    ]);
    expect(mocks.markers.get("typescript")).toEqual([]);
    expect(mocks.markers.get("octant-language")).toEqual([
      {
        startLineNumber: 2,
        startColumn: 14,
        endLineNumber: 2,
        endColumn: 19,
        severity: 8,
        message: "Type 'string' is not assignable to type 'number'.",
        source: "typescript",
      },
    ]);

    // The worker revalidates after an edit; its markers are cleared again.
    mocks.markers.set("typescript", [{ message: "single-file guess" }]);
    for (const listener of mocks.markerListeners) listener([modelUri]);
    expect(mocks.markers.get("typescript")).toEqual([]);

    session.setLanguageMarkers?.(undefined);
    expect(mocks.markers.get("octant-language")).toEqual([]);
    mocks.markers.set("typescript", [{ message: "single-file guess" }]);
    for (const listener of mocks.markerListeners) listener([modelUri]);
    expect(mocks.markers.get("typescript")).toEqual([{ message: "single-file guess" }]);
    session.dispose();
  });

  it("hands a definition in another file back to the pane rather than opening a model for it", async () => {
    const open = vi.fn();
    const session = mount(
      document.createElement("div"),
      options({
        language: "typescript",
        languageBridge: {
          definitions: async () => [
            {
              kind: "other-file",
              path: "src/greet.ts",
              range: { startLineNumber: 5, startColumn: 17, endLineNumber: 5, endColumn: 22 },
            },
          ],
          open,
        },
      }),
    );
    const provider = mocks.definitionProviders.at(-1);
    const opener = mocks.openers.at(-1);
    if (provider === undefined || opener === undefined) throw new Error("bridging not installed");

    const locations = await provider.provideDefinition(
      mocks.model,
      { lineNumber: 1, column: 8 },
      { isCancellationRequested: false },
    );
    const [location] = locations ?? [];
    expect(location?.uri).toEqual({ scheme: "octant-code-definition", path: "/file/src/greet.ts" });

    expect(
      opener.openCodeEditor(mocks.editor, location?.uri, {
        startLineNumber: 5,
        startColumn: 17,
        endLineNumber: 5,
        endColumn: 17,
      }),
    ).toBe(true);
    expect(open).toHaveBeenCalledWith({
      kind: "other-file",
      path: "src/greet.ts",
      range: { startLineNumber: 5, startColumn: 17, endLineNumber: 5, endColumn: 17 },
    });
    // Anything else Monaco opens is left to Monaco.
    expect(opener.openCodeEditor(mocks.editor, { scheme: "file", path: "/etc/hosts" })).toBe(false);
    session.dispose();
  });

  it("keeps Monaco's single-file guess out of a served file's definitions, and answers with it for a file no server serves", async () => {
    const session = mount(
      document.createElement("div"),
      options({
        language: "typescript",
        languageBridge: { definitions: async () => undefined, open: vi.fn() },
      }),
    );
    // The worker's own provider never registers, so it cannot add a second
    // answer beside the server's.
    expect(mocks.modeConfigurations).toEqual([
      ["typescript", { definitions: false, hovers: true }],
      ["javascript", { definitions: false, hovers: true }],
    ]);
    const provider = mocks.definitionProviders.at(-1);
    if (provider === undefined) throw new Error("bridging not installed");
    mocks.workerDefinitions = [
      { fileName: modelUri.toString(), textSpan: { start: 16, length: 5 } },
      { fileName: "file:///lib.es5.d.ts", textSpan: { start: 0, length: 4 } },
    ];

    const locations = await provider.provideDefinition(
      mocks.model,
      { lineNumber: 1, column: 8 },
      { isCancellationRequested: false },
    );
    expect(locations).toEqual([
      {
        uri: modelUri,
        range: { startLineNumber: 1, startColumn: 17, endLineNumber: 1, endColumn: 22 },
      },
    ]);
    session.dispose();
  });
});

function options(
  overrides: Partial<Parameters<typeof mount>[1]> = {},
): Parameters<typeof mount>[1] {
  return {
    language: "markdown",
    modelUri: "octant-code://checkout-opaque/file-opaque",
    onChange: vi.fn(),
    readOnly: false,
    value: "stale",
    ...overrides,
  };
}
