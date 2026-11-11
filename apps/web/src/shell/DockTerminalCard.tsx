import type { CodeClient } from "@octant/client-runtime/code-client";
import { CodeClientFailure } from "@octant/client-runtime/code-client";
import {
  decodeCodeTerminalId,
  type CodeCheckoutId,
  type CodeThreadId,
} from "@octant/contracts/code";
import { useCallback, useEffect, useRef, useState } from "react";
import { waitForReconnect } from "../lib/waitForReconnect";
import { waitUntilDocumentVisible } from "../polling/documentVisibility";
import { XtermTerminalAdapter, type XtermAdapterRuntime } from "../code/XtermTerminalAdapter";
import { useTypographyProjection } from "../theme/TypographyProvider";
import { DockMiniCard } from "./DockShelf";

/** The smallest size Settings allows for terminal text, so a card holds as many columns as it can. */
const MINI_TERMINAL_FONT_SIZE = 8;
/**
 * A card shows about six rows, so it keeps a few KiB of output. When the tail
 * outgrows the limit it is cut back to the keep size at a line start, so it
 * never begins inside an escape sequence; the terminal is rewritten then, and
 * only then, which a chatty shell reaches rarely rather than on every frame.
 */
const TAIL_LIMIT_CHARACTERS = 8 * 1024;
const TAIL_KEEP_CHARACTERS = 4 * 1024;
/** Re-reading a shell that ended or was refused: 5 s doubling to 60 s, six tries. */
const RETRY_FIRST_MS = 5_000;
const RETRY_LAST_MS = 60_000;
const MAX_RETRIES = 6;

type ShellState = "running" | "exited" | "interrupted";

type TerminalTail =
  | { readonly kind: "loading" }
  | { readonly kind: "none" }
  | { readonly kind: "unavailable"; readonly output: string }
  | { readonly kind: "ended"; readonly output: string }
  | {
      readonly kind: "ready";
      readonly output: string;
      readonly state: ShellState;
      readonly exitCode?: number | null;
    };

/**
 * The thread's shell as a card: its current tail, live, in a read-only terminal.
 *
 * It reads and never acts. It asks the host for the shell's state and follows
 * its live stream, which is outside the journal; it never attaches, starts,
 * writes to or resizes a shell. Attaching on a timer once wrote thousands of
 * journal entries for one pinned card, so there is no code path here that
 * could. A thread with no shell running says so, and expanding opens the tool,
 * where the person may start one. A stream that ends or is refused is asked for
 * again with a bounded back-off, paused while the window is hidden, and the card
 * says "Preview ended" when it gives up. The card belongs to one thread and
 * checkout: the caller keys it by them, and it starts from nothing for another.
 */
export function DockTerminalCard(props: {
  readonly checkoutId: CodeCheckoutId | undefined;
  readonly client: Pick<CodeClient, "inspectTerminal" | "watchTerminal">;
  readonly loadRuntime?: () => Promise<XtermAdapterRuntime>;
  readonly onHide: () => void;
  readonly onExpand: () => void;
  readonly threadId: CodeThreadId;
}) {
  const [tail, setTail] = useState<TerminalTail>({ kind: "loading" });
  const [unseen, setUnseen] = useState(false);
  // Whether the pointer or the keyboard is on the card, read inside the
  // stream's loop, which outlives any one render.
  const engaged = useRef(false);
  const typography = useTypographyProjection("terminal");
  const { checkoutId, client, threadId } = props;

  useEffect(() => {
    // Another thread's shell is never shown under this one's name.
    setTail({ kind: "loading" });
    setUnseen(false);
    if (checkoutId === undefined) {
      setTail({ kind: "none" });
      return;
    }
    const controller = new AbortController();
    const { signal } = controller;
    // At most one render for the frames of one animation frame.
    let pending: TerminalTail | undefined;
    let scheduled: number | undefined;
    const publish = (next: TerminalTail) => {
      // Only frames come fast enough to need coalescing; a state change is rare.
      if (next.kind !== "ready") {
        pending = undefined;
        if (scheduled !== undefined) cancelFrame(scheduled);
        scheduled = undefined;
        if (!signal.aborted) setTail(next);
        return;
      }
      pending = next;
      if (scheduled !== undefined) return;
      scheduled = scheduleFrame(() => {
        scheduled = undefined;
        if (pending !== undefined && !signal.aborted) setTail(pending);
        pending = undefined;
      });
    };
    let output = "";
    let state: ShellState = "running";

    /** One read of the shell's state and one stream; the outcome says whether to ask again. */
    const readOnce = async (): Promise<{ readonly frames: number; readonly settled: boolean }> => {
      let frames = 0;
      let phase: "inspect" | "watch" = "inspect";
      try {
        const terminalId = decodeCodeTerminalId(String(threadId));
        const inspection = await client.inspectTerminal({ threadId, checkoutId, terminalId });
        if (signal.aborted) return { frames, settled: true };
        phase = "watch";
        state = inspection.state;
        if (client.watchTerminal === undefined) {
          publish({ kind: "unavailable", output });
          return { frames, settled: false };
        }
        publish({ kind: "ready", output, state });
        for await (const frame of client.watchTerminal(
          { threadId, checkoutId, terminalId },
          signal,
        )) {
          const first = frames === 0;
          frames += 1;
          output = frame.replace ? cutTail(frame.text) : appendTail(output, frame.text);
          state = frame.state;
          // The first frame is the tail the shell already had; only what comes
          // after it is something that happened while the card was there.
          if (!first && !engaged.current) setUnseen(true);
          publish({
            kind: "ready",
            output,
            state,
            ...(frame.exitCode === undefined ? {} : { exitCode: frame.exitCode }),
          });
        }
        // The host ended the stream. A shell that exited said so in a frame; one
        // that did not is read again rather than left frozen as running.
        return { frames, settled: state !== "running" };
      } catch (error) {
        if (signal.aborted) return { frames, settled: true };
        // A host that cannot read the shell's state has no shell to show; a
        // refused or dropped stream, or a lost host, is a preview that cannot
        // be had, and the card stays usable either way.
        const unreadable =
          phase === "inspect" &&
          error instanceof CodeClientFailure &&
          error.category !== "disconnected";
        publish(unreadable ? { kind: "none" } : { kind: "unavailable", output });
        return { frames, settled: false };
      }
    };

    void (async () => {
      let tries = 0;
      while (!signal.aborted) {
        const result = await readOnce();
        if (signal.aborted || result.settled) return;
        // Frames flowing again is a shell worth following: start the count over.
        if (result.frames > 1) tries = 0;
        if (tries >= MAX_RETRIES) {
          publish({ kind: "ended", output });
          return;
        }
        await waitForReconnect(signal, Math.min(RETRY_FIRST_MS * 2 ** tries, RETRY_LAST_MS));
        tries += 1;
        // Nothing is asked of the host while the window is hidden.
        await waitUntilDocumentVisible(signal);
      }
    })();
    return () => {
      controller.abort();
      if (scheduled !== undefined) cancelFrame(scheduled);
    };
  }, [checkoutId, client, threadId]);

  const onEngagementChange = useCallback((now: boolean) => {
    engaged.current = now;
    if (now) setUnseen(false);
  }, []);

  return (
    <DockMiniCard
      detail={detailOf(tail)}
      newOutput={unseen}
      onHide={props.onHide}
      onEngagementChange={onEngagementChange}
      onExpand={props.onExpand}
      previewLabel="Show Terminal, live preview"
      surface="terminal"
      title="Terminal"
      toolLabel="Terminal"
    >
      {tail.kind === "loading" ? (
        <span className="skeleton dock-mini-card__skeleton dock-mini-card__skeleton--terminal" />
      ) : tail.kind === "none" ? (
        <p className="dock-mini-card__note">No terminal running</p>
      ) : tail.kind === "unavailable" && tail.output === "" ? (
        <p className="dock-mini-card__note">Preview unavailable</p>
      ) : (
        <div className="dock-mini-card__terminal">
          <XtermTerminalAdapter
            ariaLabel="Terminal preview"
            interactive={false}
            {...(props.loadRuntime === undefined ? {} : { loadRuntime: props.loadRuntime })}
            onData={ignore}
            onResize={ignore}
            output={tail.output}
            typography={{ ...typography, fontSize: MINI_TERMINAL_FONT_SIZE }}
          />
        </div>
      )}
    </DockMiniCard>
  );
}

function ignore(): void {}

/** Adds output to the tail, cutting it back only when it has outgrown the limit. */
function appendTail(output: string, text: string): string {
  const next = `${output}${text}`;
  return next.length > TAIL_LIMIT_CHARACTERS ? cutTail(next) : next;
}

/** The last part of the output, starting at a line so no escape sequence is cut at its head. */
function cutTail(output: string): string {
  if (output.length <= TAIL_KEEP_CHARACTERS) return output;
  const from = output.length - TAIL_KEEP_CHARACTERS;
  const lineStart = output.indexOf("\n", from);
  return lineStart < 0 ? output.slice(from) : output.slice(lineStart + 1);
}

function scheduleFrame(run: () => void): number {
  return typeof requestAnimationFrame === "function"
    ? requestAnimationFrame(run)
    : window.setTimeout(run, 16);
}

function cancelFrame(handle: number): void {
  if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(handle);
  else window.clearTimeout(handle);
}

function detailOf(tail: TerminalTail): string | undefined {
  if (tail.kind === "ended") return "Preview ended";
  if (tail.kind === "unavailable" && tail.output !== "") return "Preview unavailable";
  if (tail.kind !== "ready") return undefined;
  if (tail.state === "interrupted") return "Interrupted";
  if (tail.state === "exited") {
    return tail.exitCode === undefined || tail.exitCode === null
      ? "Exited"
      : `Exited (${tail.exitCode})`;
  }
  return undefined;
}
