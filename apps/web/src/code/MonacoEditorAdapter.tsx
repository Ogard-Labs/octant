import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { EditorTypographyProjection } from "@octant/theme/typography";
import { useTypographyProjection } from "../theme/TypographyProvider";

export interface MonacoAdapterSession {
  readonly dispose: () => void;
  readonly focus: () => void;
  readonly setReadOnly: (readOnly: boolean) => void;
  readonly setTypography?: (typography: EditorTypographyProjection) => void;
  readonly setValue: (value: string) => void;
}

export interface MonacoAdapterRuntime {
  readonly mount: (
    element: HTMLElement,
    options: {
      readonly language: string;
      readonly modelUri: string;
      readonly onChange: (value: string) => void;
      readonly readOnly: boolean;
      readonly typography?: EditorTypographyProjection;
      readonly value: string;
    },
  ) => MonacoAdapterSession;
}

export interface MonacoDiffSession {
  readonly dispose: () => void;
  readonly setRenderSideBySide: (sideBySide: boolean) => void;
  readonly setTypography?: (typography: EditorTypographyProjection) => void;
  readonly setValues: (values: { readonly original: string; readonly modified: string }) => void;
}

export interface MonacoDiffRuntime {
  readonly mountDiff: (
    element: HTMLElement,
    options: {
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
  readonly loadRuntime?: () => Promise<MonacoAdapterRuntime>;
  readonly modelUri: string;
  readonly onChange: (value: string) => void;
  readonly onSave?: () => void;
  readonly readOnly: boolean;
  readonly typography?: EditorTypographyProjection;
  readonly value: string;
}

export function MonacoEditorAdapter(props: MonacoEditorAdapterProps) {
  const contextualTypography = useTypographyProjection("editor");
  const typography = props.typography ?? contextualTypography;
  const [runtimeUnavailable, setRuntimeUnavailable] = useState(false);
  const element = useRef<HTMLDivElement>(null);
  const latestProps = useRef(props);
  const latestTypography = useRef(typography);
  const session = useRef<MonacoAdapterSession | undefined>(undefined);
  const loader = props.loadRuntime ?? loadMonacoRuntime;

  useLayoutEffect(() => {
    latestProps.current = props;
  }, [props]);

  useLayoutEffect(() => {
    latestTypography.current = typography;
  }, [typography]);

  useEffect(() => {
    let disposed = false;
    setRuntimeUnavailable(false);
    void loader()
      .then((runtime) => {
        if (disposed || element.current === null) return;
        const mounted = runtime.mount(element.current, {
          language: props.language,
          modelUri: props.modelUri,
          onChange: (nextValue) => latestProps.current.onChange(nextValue),
          readOnly: latestProps.current.readOnly,
          typography: latestTypography.current,
          value: latestProps.current.value,
        });
        if (disposed) mounted.dispose();
        else session.current = mounted;
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
        <p role="alert">The Code editor engine is unavailable. Retry this tab.</p>
      ) : null}
    </>
  );
}

async function loadMonacoRuntime(): Promise<MonacoAdapterRuntime> {
  return import("./monacoRuntime");
}
