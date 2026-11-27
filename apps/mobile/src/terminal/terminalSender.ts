/** One thing the phone sends a shell. */
export type TerminalSend =
  | { readonly kind: "write"; readonly data: string }
  | { readonly kind: "resize"; readonly columns: number; readonly rows: number };

export interface TerminalSender {
  readonly write: (data: string) => void;
  readonly resize: (columns: number, rows: number) => void;
  /** Drops what is waiting, as when the shell is stopped. */
  readonly close: () => void;
}

/**
 * Sends a shell's input one request at a time, in the order it was typed.
 * Each key used to be its own request, and requests in flight together can
 * reach the host in any order over a relay, so `ls` Return could arrive as
 * `l`, Return, `s`. What is typed while a request is in flight goes in the
 * next one, and of several sizes waiting only the last is sent.
 */
export function createTerminalSender(send: (item: TerminalSend) => Promise<void>): TerminalSender {
  const waiting: TerminalSend[] = [];
  let sending = false;
  let closed = false;

  const pump = async () => {
    if (sending) return;
    sending = true;
    try {
      while (!closed) {
        const next = waiting.shift();
        if (next === undefined) break;
        try {
          await send(next);
        } catch {
          // The caller reports a failed send; what was typed after it still goes.
        }
      }
    } finally {
      sending = false;
    }
  };

  const enqueue = (item: TerminalSend) => {
    if (closed) return;
    const last = waiting.at(-1);
    if (item.kind === "write" && last?.kind === "write") {
      waiting[waiting.length - 1] = { kind: "write", data: last.data + item.data };
    } else if (item.kind === "resize" && last?.kind === "resize") {
      waiting[waiting.length - 1] = item;
    } else {
      waiting.push(item);
    }
    void pump();
  };

  return {
    write: (data) => enqueue({ kind: "write", data }),
    resize: (columns, rows) => enqueue({ kind: "resize", columns, rows }),
    close: () => {
      closed = true;
      waiting.length = 0;
    },
  };
}
