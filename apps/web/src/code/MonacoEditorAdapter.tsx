import { OctantSwitch } from "../ui/base/OctantSwitch";
import type {
  CodeIntelligenceFeature,
  CodeIntelligenceAnswer,
  CodeIntelligenceItem,
} from "@octant/contracts/code-language";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantSelectField } from "../ui/base/OctantSelect";
import {
  readEditorPreferences,
  subscribeEditorPreferences,
  writeEditorPreferences,
  type EditorPreferences,
} from "../editor/editorPreferences";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { EditorColorProjection } from "@octant/theme/editor-colors";
import type { EditorTypographyProjection } from "@octant/theme/typography";
import { useEditorColorProjection } from "../theme/ThemeSettingsProvider";
import { useTypographyProjection } from "../theme/TypographyProvider";
import { OctantAlert } from "../ui/base/OctantAlert";

/** One-based, as Monaco counts lines and UTF-16 columns. */
export interface MonacoEditorRange {
  readonly startLineNumber: number;
  readonly startColumn: number;
  readonly endLineNumber: number;
  readonly endColumn: number;
}

export interface MonacoEditorPosition {
  readonly lineNumber: number;
  readonly column: number;
}

export interface MonacoEditorView {
  readonly lineNumber: number;
  readonly column: number;
  readonly scrollTop: number;
  readonly scrollLeft: number;
}

/** A diagnostic the host's language server reported for this file. */
export interface MonacoEditorMarker {
  readonly range: MonacoEditorRange;
  readonly severity: "error" | "warning" | "information" | "hint";
  readonly message: string;
  readonly source: string;
}

/**
 * Where a definition is. Only `this-file` is a place Monaco can show itself;
 * the others go back to the pane, which opens the file through the ordinary
 * file-open path or says the definition is outside the checkout.
 */
export type MonacoDefinitionLink =
  | { readonly kind: "this-file"; readonly range: MonacoEditorRange }
  | { readonly kind: "other-file"; readonly path: string; readonly range: MonacoEditorRange }
  | { readonly kind: "outside"; readonly label: "bundled-library" | "elsewhere" };

/** How an editor reaches the host's language server for its file. */
export interface MonacoLanguageBridge {
  readonly intelligence?: (
    position: MonacoEditorPosition,
    feature: CodeIntelligenceFeature,
    formatting?: { readonly tabSize: number; readonly insertSpaces: boolean },
  ) => Promise<CodeIntelligenceAnswer | undefined>;
  /** Undefined while no server serves the file: Monaco's own worker answers. */
  readonly definitions: (
    position: MonacoEditorPosition,
  ) => Promise<ReadonlyArray<MonacoDefinitionLink> | undefined>;
  readonly open: (link: Exclude<MonacoDefinitionLink, { readonly kind: "this-file" }>) => void;
}

/**
 * What a debugger shows in the editor's gutter: the window's breakpoints for
 * this file and, while the program is stopped in it, the line it stopped on.
 * Lines are one-based.
 */
export interface MonacoDebugDecorations {
  readonly breakpoints: ReadonlyArray<number>;
  readonly unresolvedBreakpoints?: ReadonlyArray<number>;
  readonly stoppedLine?: number;
}

export interface MonacoTextSelection {
  readonly text: string;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly range: MonacoEditorRange;
}
export interface MonacoAdapterSession {
  readonly selection?: () => MonacoTextSelection | undefined;
  readonly dispose: () => void;
  readonly focus: () => void;
  readonly command?: (id: string) => Promise<void>;
  readonly setPreferences?: (preferences: EditorPreferences) => void;
  readonly setReadOnly: (readOnly: boolean) => void;
  readonly setTypography?: (typography: EditorTypographyProjection) => void;
  /** Repaints in the app's current theme while the editor stays mounted. */
  readonly setColors?: (colors: EditorColorProjection) => void;
  readonly setValue: (value: string) => void;
  /**
   * The host's diagnostics for this model, or undefined when no language
   * server serves it. While they are set they are the only diagnostics the
   * model shows: Monaco's own worker reads one file without the Project, so
   * its errors would contradict the server's.
   */
  readonly setLanguageMarkers?: (markers: ReadonlyArray<MonacoEditorMarker> | undefined) => void;
  readonly revealRange?: (range: MonacoEditorRange) => void;
  readonly setDebugDecorations?: (decorations: MonacoDebugDecorations) => void;
}

export interface MonacoAdapterRuntime {
  readonly mount: (
    element: HTMLElement,
    options: {
      readonly colors?: EditorColorProjection;
      readonly language: string;
      /** Answers definitions while a language server serves this model. */
      readonly languageBridge?: MonacoLanguageBridge;
      readonly viewState?: MonacoEditorView;
      readonly onViewState?: (view: MonacoEditorView) => void;
      readonly modelUri: string;
      readonly onChange: (value: string) => void;
      readonly onCursorPosition?: (position: MonacoEditorPosition) => void;
      readonly onReferences?: (position: MonacoEditorPosition) => void;
      /**
       * A click in the gutter, or F9, on a line: the editor shows a gutter
       * for breakpoints only when this is given.
       */
      readonly onToggleBreakpoint?: (lineNumber: number) => void;
      readonly readOnly: boolean;
      readonly typography?: EditorTypographyProjection;
      readonly value: string;
    },
  ) => MonacoAdapterSession;
}

export interface MonacoDiffSession {
  readonly dispose: () => void;
  readonly setRenderSideBySide: (sideBySide: boolean) => void;
  readonly setColors?: (colors: EditorColorProjection) => void;
  readonly setTypography?: (typography: EditorTypographyProjection) => void;
  readonly setValues: (values: { readonly original: string; readonly modified: string }) => void;
  readonly setIgnoreTrimWhitespace?: (ignore: boolean) => void;
}

export interface MonacoDiffRuntime {
  readonly mountDiff: (
    element: HTMLElement,
    options: {
      readonly colors?: EditorColorProjection;
      readonly language: string;
      readonly modelUriBase: string;
      readonly original: string;
      readonly modified: string;
      readonly renderSideBySide: boolean;
      readonly ignoreTrimWhitespace?: boolean;
      readonly onSelectLine?: (selection: {
        readonly side: "original" | "modified";
        readonly line: number;
      }) => void;
      readonly typography?: EditorTypographyProjection;
    },
  ) => MonacoDiffSession;
}

export interface MonacoEditorAdapterProps {
  readonly viewState?: MonacoEditorView | undefined;
  readonly onViewState?: ((view: MonacoEditorView) => void) | undefined;
  readonly ariaLabel: string;
  readonly language: string;
  readonly languageBridge?: MonacoLanguageBridge;
  /** See {@link MonacoAdapterSession.setLanguageMarkers}. */
  readonly languageMarkers?: ReadonlyArray<MonacoEditorMarker> | undefined;
  /** A place to show; a new object asks again for the same range. */
  readonly reveal?: { readonly range: MonacoEditorRange } | undefined;
  readonly loadRuntime?: () => Promise<MonacoAdapterRuntime>;
  readonly modelUri: string;
  readonly onChange: (value: string) => void;
  readonly onCursorPosition?: (position: MonacoEditorPosition) => void;
  readonly onReferences?: (position: MonacoEditorPosition) => void;
  readonly onSave?: () => void | Promise<void>;
  readonly onReadySave?: (save: (() => Promise<void>) | undefined) => void;
  readonly onAddSelectionToChat?: (selection: MonacoTextSelection) => void;
  readonly debugDecorations?: MonacoDebugDecorations;
  readonly onToggleBreakpoint?: (lineNumber: number) => void;
  readonly readOnly: boolean;
  readonly typography?: EditorTypographyProjection;
  readonly value: string;
}

export function MonacoEditorAdapter(props: MonacoEditorAdapterProps) {
  const contextualTypography = useTypographyProjection("editor");
  const typography = props.typography ?? contextualTypography;
  const colors = useEditorColorProjection();
  const [runtimeUnavailable, setRuntimeUnavailable] = useState(false);
  const element = useRef<HTMLDivElement>(null);
  const latestProps = useRef(props);
  const latestTypography = useRef(typography);
  const latestColors = useRef(colors);
  const session = useRef<MonacoAdapterSession | undefined>(undefined);
  const [preferences, setPreferences] = useState(readEditorPreferences);
  const latestPreferences = useRef(preferences);
  latestPreferences.current = preferences;
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [outline, setOutline] = useState<ReadonlyArray<CodeIntelligenceItem>>();
  const [outlineBusy, setOutlineBusy] = useState(false);
  const outlineGeneration = useRef(0);
  useEffect(() => {
    outlineGeneration.current += 1;
    setOutline(undefined);
    setOutlineBusy(false);
    return () => {
      outlineGeneration.current += 1;
    };
  }, [props.modelUri, props.value]);
  const showOutline = async () => {
    if (outline !== undefined) {
      setOutline(undefined);
      return;
    }
    const generation = ++outlineGeneration.current;
    const uri = latestProps.current.modelUri;
    const text = latestProps.current.value;
    setOutlineBusy(true);
    try {
      const answer = await latestProps.current.languageBridge?.intelligence?.(
        { lineNumber: 1, column: 1 },
        "symbols",
      );
      if (
        outlineGeneration.current !== generation ||
        latestProps.current.modelUri !== uri ||
        latestProps.current.value !== text
      )
        return;
      if (answer === undefined)
        setNotice("An outline is unavailable from this file's language server.");
      else {
        setOutline(answer.items);
        setNotice(answer.truncated ? "The outline is incomplete." : undefined);
      }
    } catch {
      if (outlineGeneration.current === generation)
        setNotice("The outline could not be loaded. Try again.");
    } finally {
      if (outlineGeneration.current === generation) setOutlineBusy(false);
    }
  };
  const command = async (id: string) => {
    try {
      await session.current?.command?.(id);
    } catch {
      setNotice("This command is unavailable for the current file.");
    }
  };
  const save = async () => {
    if (latestProps.current.readOnly || latestProps.current.onSave === undefined) return;
    try {
      if (latestPreferences.current.formatOnSave)
        await session.current?.command?.("editor.action.formatDocument");
      await latestProps.current.onSave?.();
    } catch {
      setNotice("Formatting failed. Turn off format on save to save the current text.");
    }
  };
  const update = (next: EditorPreferences) => {
    setPreferences(next);
    session.current?.setPreferences?.(next);
    if (!writeEditorPreferences(next))
      setNotice("Editor preferences could not be kept on this device.");
  };
  const loader = props.loadRuntime ?? loadMonacoRuntime;

  useLayoutEffect(() => {
    latestProps.current = props;
  }, [props]);

  useLayoutEffect(() => {
    latestTypography.current = typography;
  }, [typography]);

  useLayoutEffect(() => {
    latestColors.current = colors;
  }, [colors]);

  useEffect(() => {
    let disposed = false;
    setRuntimeUnavailable(false);
    void loader()
      .then((runtime) => {
        if (disposed || element.current === null) return;
        const mounted = runtime.mount(element.current, {
          colors: latestColors.current,
          language: props.language,
          // Read through the latest props, so a bridge that changes with the
          // pane's state never remounts the editor.
          ...(latestProps.current.languageBridge === undefined
            ? {}
            : {
                languageBridge: {
                  intelligence: (position, feature, formatting) =>
                    latestProps.current.languageBridge?.intelligence?.(
                      position,
                      feature,
                      formatting,
                    ) ?? Promise.resolve(undefined),
                  definitions: (position) =>
                    latestProps.current.languageBridge?.definitions(position) ??
                    Promise.resolve(undefined),
                  open: (link) => latestProps.current.languageBridge?.open(link),
                },
              }),
          modelUri: props.modelUri,
          ...(latestProps.current.viewState === undefined
            ? {}
            : { viewState: latestProps.current.viewState }),
          ...(latestProps.current.onViewState === undefined
            ? {}
            : { onViewState: (view: MonacoEditorView) => latestProps.current.onViewState?.(view) }),
          onChange: (nextValue) => latestProps.current.onChange(nextValue),
          ...(latestProps.current.onCursorPosition === undefined
            ? {}
            : { onCursorPosition: (position) => latestProps.current.onCursorPosition?.(position) }),
          ...(latestProps.current.onReferences === undefined
            ? {}
            : { onReferences: (position) => latestProps.current.onReferences?.(position) }),
          ...(latestProps.current.onToggleBreakpoint === undefined
            ? {}
            : {
                onToggleBreakpoint: (lineNumber: number) =>
                  latestProps.current.onToggleBreakpoint?.(lineNumber),
              }),
          readOnly: latestProps.current.readOnly,
          typography: latestTypography.current,
          value: latestProps.current.value,
        });
        if (disposed) {
          mounted.dispose();
          return;
        }
        session.current = mounted;
        latestProps.current.onReadySave?.(save);
        mounted.setPreferences?.(latestPreferences.current);
        mounted.setLanguageMarkers?.(latestProps.current.languageMarkers);
        const reveal = latestProps.current.reveal;
        if (reveal !== undefined) mounted.revealRange?.(reveal.range);
        const debug = latestProps.current.debugDecorations;
        if (debug !== undefined) mounted.setDebugDecorations?.(debug);
      })
      .catch(() => {
        if (!disposed) setRuntimeUnavailable(true);
      });
    return () => {
      disposed = true;
      latestProps.current.onReadySave?.(undefined);
      session.current?.dispose();
      session.current = undefined;
    };
  }, [loader, props.language, props.modelUri]);

  useEffect(
    () =>
      subscribeEditorPreferences(() => {
        const next = readEditorPreferences();
        setPreferences(next);
        session.current?.setPreferences?.(next);
      }),
    [],
  );

  useEffect(() => session.current?.setValue(props.value), [props.value]);
  useEffect(() => session.current?.setReadOnly(props.readOnly), [props.readOnly]);
  useEffect(() => session.current?.setTypography?.(typography), [typography]);
  useEffect(() => session.current?.setColors?.(colors), [colors]);
  useEffect(
    () => session.current?.setLanguageMarkers?.(props.languageMarkers),
    [props.languageMarkers],
  );
  useEffect(() => {
    if (props.reveal !== undefined) session.current?.revealRange?.(props.reveal.range);
  }, [props.reveal]);
  useEffect(() => {
    if (props.debugDecorations !== undefined) {
      session.current?.setDebugDecorations?.(props.debugDecorations);
    }
  }, [props.debugDecorations]);

  return (
    <>
      <div className="editor-tools" role="toolbar" aria-label="Editor commands">
        <OctantButton
          size="sm"
          variant="ghost"
          onClick={() => void command("editor.action.quickCommand")}
        >
          Commands
        </OctantButton>
        <OctantButton size="sm" variant="ghost" onClick={() => void command("actions.find")}>
          Find
        </OctantButton>
        <OctantButton
          size="sm"
          variant="ghost"
          disabled={props.readOnly}
          onClick={() => void command("editor.action.startFindReplaceAction")}
        >
          Replace
        </OctantButton>
        <OctantButton
          size="sm"
          variant="ghost"
          disabled={props.readOnly}
          onClick={() => void command("editor.action.formatDocument")}
        >
          Format
        </OctantButton>
        <OctantButton
          size="sm"
          variant="ghost"
          onClick={() => void command("editor.action.gotoLine")}
        >
          Go to line
        </OctantButton>
        {props.languageBridge?.intelligence === undefined ? null : (
          <OctantButton
            size="sm"
            variant="ghost"
            disabled={outlineBusy}
            aria-expanded={outline !== undefined}
            onClick={() => void showOutline()}
          >
            Outline
          </OctantButton>
        )}
        {props.onAddSelectionToChat === undefined ? null : (
          <OctantButton
            size="sm"
            variant="ghost"
            onClick={() => {
              const selected = session.current?.selection?.();
              if (selected === undefined) setNotice("Select some text in the editor first.");
              else {
                props.onAddSelectionToChat?.(selected);
                setNotice(
                  "Selection added to the conversation draft. Send it from the conversation to ask the agent.",
                );
              }
            }}
          >
            Send selection to agent
          </OctantButton>
        )}
        <OctantButton
          size="sm"
          variant="ghost"
          aria-expanded={preferencesOpen}
          onClick={() => setPreferencesOpen(!preferencesOpen)}
        >
          Editor settings
        </OctantButton>
      </div>
      {preferencesOpen ? (
        <fieldset className="editor-tools">
          <legend>Editor settings</legend>
          <span className="editor-preference">
            <OctantSwitch
              label="Wrap lines"
              checked={preferences.wordWrap === "on"}
              onCheckedChange={(checked) =>
                update({ ...preferences, wordWrap: checked ? "on" : "off" })
              }
            />{" "}
            Wrap lines
          </span>
          <span className="editor-preference">
            <OctantSwitch
              label="Show whitespace"
              checked={preferences.renderWhitespace === "all"}
              onCheckedChange={(checked) =>
                update({ ...preferences, renderWhitespace: checked ? "all" : "none" })
              }
            />{" "}
            Show whitespace
          </span>
          <span className="editor-preference">
            <OctantSwitch
              label="Minimap"
              checked={preferences.minimap}
              onCheckedChange={(checked) => update({ ...preferences, minimap: checked })}
            />{" "}
            Minimap
          </span>
          <span className="editor-preference">
            <OctantSwitch
              label="Insert spaces"
              checked={preferences.insertSpaces}
              onCheckedChange={(checked) => update({ ...preferences, insertSpaces: checked })}
            />{" "}
            Insert spaces
          </span>
          <span className="editor-preference">
            <OctantSwitch
              label="Format on save"
              checked={preferences.formatOnSave}
              onCheckedChange={(checked) => update({ ...preferences, formatOnSave: checked })}
            />{" "}
            Format on save
          </span>
          <OctantSelectField
            aria-label="Indent size"
            value={String(preferences.tabSize)}
            options={[2, 4, 8].map((size) => ({ id: String(size), label: `${size} columns` }))}
            onValueChange={(value) => update({ ...preferences, tabSize: Number(value) })}
          />
        </fieldset>
      ) : null}
      {notice === undefined ? null : <p role="status">{notice}</p>}
      {outlineBusy ? <p role="status">Loading outline…</p> : null}
      {outline === undefined ? null : (
        <section className="code-editor-pane__references" aria-label="File outline">
          {outline.length === 0 ? (
            <p>No symbols returned for this file</p>
          ) : (
            <ul>
              {outline.map((item, index) => (
                <li key={index}>
                  <OctantButton
                    size="sm"
                    variant="ghost"
                    disabled={item.range === undefined}
                    onClick={() => {
                      if (item.range === undefined) return;
                      session.current?.revealRange?.({
                        startLineNumber: item.range.start.line + 1,
                        startColumn: item.range.start.character + 1,
                        endLineNumber: item.range.end.line + 1,
                        endColumn: item.range.end.character + 1,
                      });
                      session.current?.focus();
                    }}
                  >
                    {item.label}
                  </OctantButton>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section
        aria-label={props.ariaLabel}
        data-read-only={props.readOnly}
        onFocus={() => session.current?.focus()}
        onKeyDownCapture={(event) => {
          if (
            props.onSave !== undefined &&
            (event.metaKey || event.ctrlKey) &&
            event.key.toLocaleLowerCase() === "s"
          ) {
            event.preventDefault();
            if (!event.nativeEvent.isComposing) void save();
          }
        }}
        ref={element}
        tabIndex={0}
      />
      {runtimeUnavailable ? (
        <OctantAlert tone="warning">
          The Code editor engine is unavailable. Retry this tab.
        </OctantAlert>
      ) : null}
    </>
  );
}

async function loadMonacoRuntime(): Promise<MonacoAdapterRuntime> {
  return import("./monacoRuntime");
}
