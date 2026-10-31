import { useEffect, useId, useState } from "react";
import { Check } from "lucide-react";
import type { TerminalSessionClient } from "@octant/client-runtime/terminal-session-client";
import type {
  ProjectId,
  TerminalSessionImportRequest,
  TerminalSessionProvider,
  TerminalSessionSummary,
} from "@octant/contracts";
import { relativeTimeLabel } from "../lib/relativeTime";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";

export const TERMINAL_SESSION_TOOL_NAMES: Record<TerminalSessionProvider, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

type Listing =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly sessions: ReadonlyArray<TerminalSessionSummary> }
  | { readonly kind: "error"; readonly message: string };

/**
 * The sessions the provider command-line tools kept for the Project's folder
 * on this Mac. Choosing one starts the new thread from its conversation.
 */
export function CreateFromTerminalSessionPicker(props: {
  readonly client: TerminalSessionClient;
  readonly projectId: ProjectId;
  readonly disabled: boolean;
  readonly selected?: TerminalSessionImportRequest;
  readonly onSelect: (session: TerminalSessionSummary) => void;
}) {
  const listboxId = useId();
  const [listing, setListing] = useState<Listing>({ kind: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    setListing({ kind: "loading" });
    props.client.list(props.projectId, controller.signal).then(
      (sessions) => {
        if (!controller.signal.aborted) setListing({ kind: "ready", sessions });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setListing({
          kind: "error",
          message: error instanceof Error ? error.message : "Terminal sessions are unavailable.",
        });
      },
    );
    return () => controller.abort();
  }, [props.client, props.projectId]);

  return (
    <div className="create-from-issue">
      <p className="octant-popover-empty">
        Sessions from Claude Code and Codex in this Project's folder. The new thread starts with the
        conversation as read-only history.
      </p>
      {listing.kind === "loading" ? (
        <p className="octant-popover-empty" role="status">
          Looking for sessions…
        </p>
      ) : null}
      {listing.kind === "error" ? (
        <OctantAlert tone="warning">{listing.message}</OctantAlert>
      ) : null}
      {listing.kind === "ready" ? (
        listing.sessions.length === 0 ? (
          <p className="octant-popover-empty" role="status">
            No terminal sessions in this folder.
          </p>
        ) : (
          <ul aria-label="Terminal sessions" className="github-picker__listbox" id={listboxId}>
            {listing.sessions.map((session) => {
              const selected =
                props.selected !== undefined &&
                props.selected.provider === session.provider &&
                String(props.selected.sessionId) === String(session.sessionId);
              return (
                <li key={`${session.provider}:${String(session.sessionId)}`}>
                  <OctantButton
                    aria-pressed={selected}
                    className="octant-popover-option github-picker__option"
                    disabled={props.disabled}
                    onClick={() => props.onSelect(session)}
                    type="button"
                    variant="bare"
                  >
                    <span className="github-picker__option-name">{session.title}</span>
                    <span className="github-picker__option-meta terminal-session-picker__meta">
                      {TERMINAL_SESSION_TOOL_NAMES[session.provider]} ·{" "}
                      <time dateTime={session.updatedAt}>
                        {relativeTimeLabel(session.updatedAt)}
                      </time>
                    </span>
                    {selected ? (
                      <Check
                        aria-hidden="true"
                        className="octant-popover-option__check"
                        size={14}
                        strokeWidth={2}
                      />
                    ) : null}
                  </OctantButton>
                </li>
              );
            })}
          </ul>
        )
      ) : null}
    </div>
  );
}
