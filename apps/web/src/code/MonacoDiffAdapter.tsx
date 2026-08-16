import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { EditorTypographyProjection } from "@octant/theme/typography";
import { useTypographyProjection } from "../theme/TypographyProvider";
import type { MonacoDiffRuntime, MonacoDiffSession } from "./MonacoEditorAdapter";

export interface MonacoDiffAdapterProps {
  readonly ariaLabel: string;
  readonly language: string;
  readonly loadRuntime?: () => Promise<MonacoDiffRuntime>;
  readonly modelUriBase: string;
  readonly modified: string;
  readonly original: string;
  readonly renderSideBySide: boolean;
  readonly typography?: EditorTypographyProjection;
}

export function MonacoDiffAdapter(props: MonacoDiffAdapterProps) {
  const contextualTypography = useTypographyProjection("editor");
  const typography = props.typography ?? contextualTypography;
  const [runtimeUnavailable, setRuntimeUnavailable] = useState(false);
  const element = useRef<HTMLDivElement>(null);
  const latestProps = useRef(props);
  const latestTypography = useRef(typography);
  const session = useRef<MonacoDiffSession | undefined>(undefined);
  const loader = props.loadRuntime ?? loadMonacoDiffRuntime;

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
        const mounted = runtime.mountDiff(element.current, {
          language: latestProps.current.language,
          modelUriBase: props.modelUriBase,
          original: latestProps.current.original,
          modified: latestProps.current.modified,
          renderSideBySide: latestProps.current.renderSideBySide,
          typography: latestTypography.current,
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
  }, [loader, props.modelUriBase]);

  useEffect(
    () => session.current?.setValues({ original: props.original, modified: props.modified }),
    [props.modified, props.original],
  );
  useEffect(
    () => session.current?.setRenderSideBySide(props.renderSideBySide),
    [props.renderSideBySide],
  );
  useEffect(() => session.current?.setTypography?.(typography), [typography]);

  return (
    <>
      <section aria-label={props.ariaLabel} className="code-diff-pane__editor" ref={element} />
      {runtimeUnavailable ? (
        <p role="alert">The Code editor engine is unavailable. Retry this tab.</p>
      ) : null}
    </>
  );
}

async function loadMonacoDiffRuntime(): Promise<MonacoDiffRuntime> {
  return import("./monacoRuntime");
}
