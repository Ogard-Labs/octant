import { useEffect, useMemo, useState } from "react";
import {
  createTerminalSessionClient,
  type TerminalSessionClient,
} from "@octant/client-runtime/terminal-session-client";
import type { ImportedTerminalSession } from "@octant/contracts";
import { absoluteTimeFormatter } from "../lib/relativeTime";
import { TERMINAL_SESSION_TOOL_NAMES } from "./CreateFromTerminalSessionPicker";

/**
 * The terminal session a Work or Code thread started from, above its own
 * conversation. It is read-only and folded by default: it is a record of what
 * was said elsewhere, which the model read once as outside content, not turns
 * of this thread.
 */
export function ImportedTerminalHistory(props: {
  readonly threadId: string;
  readonly serverUrl?: string;
  readonly windowCapability?: string;
  /** For tests; the host's client otherwise. */
  readonly client?: TerminalSessionClient;
}) {
  const client = useMemo(() => {
    if (props.client !== undefined) return props.client;
    if (props.serverUrl === undefined || props.windowCapability === undefined) return undefined;
    try {
      return createTerminalSessionClient({
        baseUrl: props.serverUrl,
        fetch: globalThis.fetch,
        windowCapability: props.windowCapability,
      });
    } catch {
      return undefined;
    }
  }, [props.client, props.serverUrl, props.windowCapability]);
  const [imported, setImported] = useState<ImportedTerminalSession | undefined>(undefined);
  useEffect(() => {
    setImported(undefined);
    if (client === undefined) return;
    const controller = new AbortController();
    client.history(props.threadId, controller.signal).then(
      (history) => {
        if (!controller.signal.aborted) setImported(history);
      },
      // A thread whose history cannot be read still shows its own turns.
      () => undefined,
    );
    return () => controller.abort();
  }, [client, props.threadId]);
  if (imported === undefined) return null;
  const tool = TERMINAL_SESSION_TOOL_NAMES[imported.provider];
  return (
    <details className="imported-history thread-column">
      <summary className="imported-history__summary">
        <span className="imported-history__title">
          Started from a {tool} session: {imported.title}
        </span>
        <span className="imported-history__meta">
          {imported.entries.length === 1 ? "1 message" : `${imported.entries.length} messages`} ·
          last active{" "}
          <time dateTime={imported.updatedAt}>
            {absoluteTimeFormatter.format(new Date(imported.updatedAt))}
          </time>
        </span>
      </summary>
      <p className="imported-history__note">
        Outside content, read from this Mac. The assistant read it once at the start of this thread;
        it is not a message anyone sent here.
        {imported.truncated ? " Older messages were left out." : ""}
      </p>
      <ol aria-label={`Imported ${tool} conversation`} className="imported-history__entries">
        {imported.entries.map((entry, index) => (
          <li className="imported-history__entry" data-role={entry.role} key={index}>
            <span className="imported-history__role">{entry.role === "user" ? "You" : tool}</span>
            <p className="imported-history__text">{entry.text}</p>
          </li>
        ))}
      </ol>
    </details>
  );
}
