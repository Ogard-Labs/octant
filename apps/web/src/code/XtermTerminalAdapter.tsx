import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { TerminalTypographyProjection } from "@octant/theme/typography";
import { useTypographyProjection } from "../theme/TypographyProvider";

export interface XtermAdapterSession {
  readonly dispose: () => void;
  readonly focus: () => void;
  /** The text the user has selected in the terminal, empty when none is. */
  readonly readSelection?: () => string;
  readonly setInteractive: (interactive: boolean) => void;
  readonly setOutput: (output: string) => void;
  readonly setTypography?: (typography: TerminalTypographyProjection) => void;
}

export interface XtermAdapterRuntime {
  readonly mount: (
    element: HTMLElement,
    options: {
      readonly interactive: boolean;
      readonly onData: (data: string) => void;
      readonly onResize: (columns: number, rows: number) => void;
      readonly output: string;
      readonly typography?: TerminalTypographyProjection;
    },
  ) => XtermAdapterSession;
}

export interface XtermTerminalAdapterProps {
  readonly ariaLabel: string;
  readonly interactive: boolean;
  readonly loadRuntime?: () => Promise<XtermAdapterRuntime>;
  readonly onData: (data: string) => void;
  readonly onResize: (columns: number, rows: number) => void;
  /**
   * Hands the caller a way to read the terminal's current selection, and
   * `undefined` once the session is gone. The selection lives in the terminal
   * engine, so nothing above this adapter can observe it without being given a
   * reader.
   */
  readonly onSelectionReader?: (read: (() => string) | undefined) => void;
  readonly output: string;
  readonly typography?: TerminalTypographyProjection;
}

export function XtermTerminalAdapter(props: XtermTerminalAdapterProps) {
  const contextualTypography = useTypographyProjection("terminal");
  const typography = props.typography ?? contextualTypography;
  const [runtimeUnavailable, setRuntimeUnavailable] = useState(false);
  const element = useRef<HTMLDivElement>(null);
  const latestProps = useRef(props);
  const latestTypography = useRef(typography);
  const session = useRef<XtermAdapterSession | undefined>(undefined);
  const loader = props.loadRuntime ?? loadXtermRuntime;

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
          interactive: latestProps.current.interactive,
          onData: (data) => latestProps.current.onData(data),
          onResize: (columns, rows) => latestProps.current.onResize(columns, rows),
          output: latestProps.current.output,
          typography: latestTypography.current,
        });
        if (disposed) {
          mounted.dispose();
          return;
        }
        session.current = mounted;
        const read = mounted.readSelection;
        latestProps.current.onSelectionReader?.(read === undefined ? undefined : () => read());
      })
      .catch(() => {
        if (!disposed) setRuntimeUnavailable(true);
      });
    return () => {
      disposed = true;
      session.current?.dispose();
      session.current = undefined;
      latestProps.current.onSelectionReader?.(undefined);
    };
  }, [loader]);

  useEffect(() => session.current?.setOutput(props.output), [props.output]);
  useEffect(() => session.current?.setInteractive(props.interactive), [props.interactive]);
  useEffect(() => session.current?.setTypography?.(typography), [typography]);

  return (
    <>
      <section
        aria-label={props.ariaLabel}
        data-read-only={!props.interactive}
        onFocus={() => session.current?.focus()}
        ref={element}
        tabIndex={0}
      />
      {runtimeUnavailable ? (
        <p role="alert">The Code terminal engine is unavailable. Retry this tab.</p>
      ) : null}
    </>
  );
}

async function loadXtermRuntime(): Promise<XtermAdapterRuntime> {
  return import("./xtermRuntime");
}
