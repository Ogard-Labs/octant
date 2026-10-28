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
  readonly stoppedLine?: number;
}

export interface MonacoAdapterSession {
  readonly dispose: () => void;
  readonly focus: () => void;
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
      readonly modelUri: string;
      readonly onChange: (value: string) => void;
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
      readonly typography?: EditorTypographyProjection;
    },
  ) => MonacoDiffSession;
}

export interface MonacoEditorAdapterProps {
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
  readonly onSave?: () => void;
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
                  definitions: (position) =>
                    latestProps.current.languageBridge?.definitions(position) ??
                    Promise.resolve(undefined),
                  open: (link) => latestProps.current.languageBridge?.open(link),
                },
              }),
          modelUri: props.modelUri,
          onChange: (nextValue) => latestProps.current.onChange(nextValue),
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
      session.current?.dispose();
      session.current = undefined;
    };
  }, [loader, props.language, props.modelUri]);

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
            props.onSave();
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
