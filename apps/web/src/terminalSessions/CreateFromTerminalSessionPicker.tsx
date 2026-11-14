import { useEffect, useId, useState } from "react";
import { Check, SquareTerminal } from "lucide-react";
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
import { PopupSkeletonRows } from "../ui/base/PopupSkeletonRows";
import { loadList, peekList } from "../composer/createFromCache";

export const TERMINAL_SESSION_TOOL_NAMES: Record<TerminalSessionProvider, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

const terminalSessionsKey = (projectId: ProjectId) => `terminal-sessions:${String(projectId)}`;

/** The sessions kept for a Project's folder, shared with whoever reads ahead of the popup opening. */
export function loadTerminalSessions(
  client: TerminalSessionClient,
  projectId: ProjectId,
): Promise<ReadonlyArray<TerminalSessionSummary>> {
  return loadList(client, terminalSessionsKey(projectId), () => client.list(projectId));
}

const HANDOFF_NOTE =
  "Sessions from Claude Code and Codex in this Project's folders. Choose a text handoff to start a new session with read-only visible conversation. Native adoption is unavailable because this host cannot verify the source account and exclusive session ownership. Original inputs, tool activity and hidden reasoning are omitted.";

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
  const [listing, setListing] = useState<Listing>(() => {
    const cached = peekList<ReadonlyArray<TerminalSessionSummary>>(
      props.client,
      terminalSessionsKey(props.projectId),
    );
    return cached === undefined ? { kind: "loading" } : { kind: "ready", sessions: cached.value };
  });
  useEffect(() => {
    let alive = true;
    const cached = peekList<ReadonlyArray<TerminalSessionSummary>>(
      props.client,
      terminalSessionsKey(props.projectId),
    );
    setListing(
      cached === undefined ? { kind: "loading" } : { kind: "ready", sessions: cached.value },
    );
    if (cached?.fresh === true) return undefined;
    loadTerminalSessions(props.client, props.projectId).then(
      (sessions) => {
        if (alive) setListing({ kind: "ready", sessions });
      },
      (error: unknown) => {
        if (!alive || cached !== undefined) return;
        setListing({
          kind: "error",
          message: error instanceof Error ? error.message : "Terminal sessions are unavailable.",
        });
      },
    );
    return () => {
      alive = false;
    };
  }, [props.client, props.projectId]);

  return (
    <div className="create-from-issue">
      <p className="oct-menu-detail create-from__note" title={HANDOFF_NOTE}>
        Sessions from Claude Code and Codex in this Project's folders, continued as a text handoff.
      </p>
      {listing.kind === "loading" ? <PopupSkeletonRows label="Looking for sessions…" /> : null}
      {listing.kind === "error" ? (
        <OctantAlert tone="warning">{listing.message}</OctantAlert>
      ) : null}
      {listing.kind === "ready" ? (
        listing.sessions.length === 0 ? (
          <p className="octant-popover-empty" role="status">
            No terminal sessions in this folder.
          </p>
        ) : (
          <ul aria-label="Terminal sessions" className="create-from__list" id={listboxId}>
            {listing.sessions.map((session) => {
              const selected =
                props.selected !== undefined &&
                props.selected.provider === session.provider &&
                String(props.selected.sessionId) === String(session.sessionId);
              return (
                <li key={`${session.provider}:${String(session.sessionId)}`}>
                  <OctantButton
                    aria-pressed={selected}
                    className="octant-popover-option create-from__row"
                    disabled={props.disabled}
                    onClick={() => props.onSelect(session)}
                    title={session.title}
                    type="button"
                    variant="bare"
                  >
                    <SquareTerminal aria-hidden="true" className="create-from__state" size={14} />
                    <span className="create-from__copy">
                      <span className="create-from__title">{session.title}</span>
                      <span className="oct-menu-detail create-from__meta">
                        {TERMINAL_SESSION_TOOL_NAMES[session.provider]} ·{" "}
                        <time dateTime={session.updatedAt}>
                          {relativeTimeLabel(session.updatedAt)}
                        </time>
                        {session.workingDirectory === undefined
                          ? ""
                          : ` · ${session.workingDirectory}`}
                      </span>
                    </span>
                    {selected ? (
                      <Check
                        aria-hidden="true"
                        className="octant-popover-option__check"
                        size={14}
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
