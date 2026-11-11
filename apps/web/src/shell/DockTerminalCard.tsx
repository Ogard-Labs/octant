import type { CodeClient } from "@octant/client-runtime/code-client";
import { CodeClientFailure } from "@octant/client-runtime/code-client";
import {
  decodeCodeTerminalId,
  type CodeCheckoutId,
  type CodeThreadId,
} from "@octant/contracts/code";
import { useCallback, useEffect, useRef, useState } from "react";
import { XtermTerminalAdapter, type XtermAdapterRuntime } from "../code/XtermTerminalAdapter";
import { useTypographyProjection } from "../theme/TypographyProvider";
import { DockMiniCard } from "./DockShelf";

/** The smallest size Settings allows for terminal text, so a card holds as many columns as it can. */
const MINI_TERMINAL_FONT_SIZE = 8;
/** What the host's live stream hands over at most as its first frame. */
const MAX_TAIL_CHARACTERS = 64 * 1024;

type ShellState = "running" | "exited" | "interrupted";

type TerminalTail =
  | { readonly kind: "loading" }
  | { readonly kind: "none" }
  | { readonly kind: "unavailable"; readonly output: string }
  | {
      readonly kind: "ready";
      readonly output: string;
      readonly state: ShellState;
      readonly exitCode?: number | null;
    };

/**
 * The thread's shell as a card: its current tail, live, in a read-only terminal.
 *
 * It reads and never acts. It asks the host for the shell's state once and
 * follows its live stream, which is outside the journal; it never attaches,
 * starts, writes to or resizes a shell. Attaching on a timer once wrote
 * thousands of journal entries for one pinned card, so there is no code path
 * here that could. A thread with no shell running says so, and expanding opens
 * the tool, where the person may start one.
 */
export function DockTerminalCard(props: {
  readonly checkoutId: CodeCheckoutId | undefined;
  readonly client: Pick<CodeClient, "inspectTerminal" | "watchTerminal">;
  readonly loadRuntime?: () => Promise<XtermAdapterRuntime>;
  readonly onClose: () => void;
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
    if (checkoutId === undefined) {
      setTail({ kind: "none" });
      return;
    }
    const controller = new AbortController();
    let output = "";
    let frames = 0;
    let phase: "inspect" | "watch" = "inspect";
    void (async () => {
      try {
        const terminalId = decodeCodeTerminalId(String(threadId));
        const inspection = await client.inspectTerminal({ threadId, checkoutId, terminalId });
        if (controller.signal.aborted) return;
        phase = "watch";
        if (client.watchTerminal === undefined) {
          setTail({ kind: "unavailable", output });
          return;
        }
        setTail({ kind: "ready", output, state: inspection.state });
        for await (const frame of client.watchTerminal(
          { threadId, checkoutId, terminalId },
          controller.signal,
        )) {
          const first = frames === 0;
          frames += 1;
          output = (frame.replace ? frame.text : `${output}${frame.text}`).slice(
            -MAX_TAIL_CHARACTERS,
          );
          // The first frame is the tail the shell already had; only what comes
          // after it is something that happened while the card was there.
          if (!first && !engaged.current) setUnseen(true);
          setTail({
            kind: "ready",
            output,
            state: frame.state,
            ...(frame.exitCode === undefined ? {} : { exitCode: frame.exitCode }),
          });
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        // A host that cannot read the shell's state has no shell to show; a
        // refused or dropped stream, or a lost host, is a preview that cannot
        // be had, and the card stays usable either way.
        const unreadable =
          phase === "inspect" &&
          error instanceof CodeClientFailure &&
          error.category !== "disconnected";
        setTail(unreadable ? { kind: "none" } : { kind: "unavailable", output });
      }
    })();
    return () => controller.abort();
  }, [checkoutId, client, threadId]);

  const onEngagementChange = useCallback((now: boolean) => {
    engaged.current = now;
    if (now) setUnseen(false);
  }, []);

  return (
    <DockMiniCard
      detail={detailOf(tail)}
      newOutput={unseen}
      onClose={props.onClose}
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

function detailOf(tail: TerminalTail): string | undefined {
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
