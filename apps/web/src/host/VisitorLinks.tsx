import { useEffect, useRef, useState } from "react";
import { SettingsState } from "../settings/primitives";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantConfirmDialog } from "../ui/base/OctantConfirmDialog";
import { OctantDialogPresence } from "../ui/base/OctantDialogPresence";
import {
  copyToClipboard,
  field,
  formatWhen,
  list,
  type HubEntranceAction,
} from "./hubEntranceAction";
import "../styles/hub-entrance.css";

/**
 * This computer's visitor links and the visitor comments waiting on them, as
 * the thread's Share with visitor dialog and Settings both show them. Stop
 * sharing revokes a link at once; a comment reaches its thread only through
 * the person's Send, which taints the thread first and hands the person the
 * framed comment to send there (hub-and-spokes.md, Visitor links).
 */

export interface VisitorLink {
  readonly linkId: string;
  readonly mode: string;
  readonly threadId: string;
  readonly scope: "read" | "comment";
  readonly expiresAt: number;
  readonly opened: boolean;
}

export interface VisitorComment {
  readonly commentId: string;
  readonly linkId: string;
  readonly text: string;
  readonly at: number;
}

export interface VisitorsView {
  readonly links: ReadonlyArray<VisitorLink>;
  readonly comments: ReadonlyArray<VisitorComment>;
  readonly published: boolean;
  /** The hub's own switch and counts, on the hub only. */
  readonly hub?: { readonly enabled: boolean; readonly grants: number; readonly streams: number };
}

export function readVisitors(value: unknown): VisitorsView | undefined {
  const spoke = field(value, "spoke");
  const links = field(spoke, "links");
  if (!Array.isArray(links)) return undefined;
  const hub = field(value, "hub");
  const enabled = field(hub, "enabled");
  const grants = field(hub, "grants");
  const streams = field(hub, "streams");
  return {
    links: links.flatMap((entry: unknown) => {
      const linkId = field(entry, "linkId");
      const mode = field(entry, "mode");
      const threadId = field(entry, "threadId");
      const scope = field(entry, "scope");
      const expiresAt = field(entry, "expiresAt");
      return typeof linkId === "string" &&
        typeof mode === "string" &&
        typeof threadId === "string" &&
        (scope === "read" || scope === "comment") &&
        typeof expiresAt === "number"
        ? [{ linkId, mode, threadId, scope, expiresAt, opened: field(entry, "opened") === true }]
        : [];
    }),
    comments: list(field(spoke, "comments")).flatMap((entry) => {
      const commentId = field(entry, "commentId");
      const linkId = field(entry, "linkId");
      const text = field(entry, "text");
      const at = field(entry, "at");
      return typeof commentId === "string" &&
        typeof linkId === "string" &&
        typeof text === "string" &&
        typeof at === "number"
        ? [{ commentId, linkId, text, at }]
        : [];
    }),
    published: field(spoke, "published") !== false,
    ...(typeof enabled === "boolean"
      ? {
          hub: {
            enabled,
            grants: typeof grants === "number" ? grants : 0,
            streams: typeof streams === "number" ? streams : 0,
          },
        }
      : {}),
  };
}

export const VISITOR_REFUSALS: Readonly<Record<string, string>> = {
  "public-not-granted": "Tick Public in this computer's hub grant first.",
  "not-a-member": "Join a hub first.",
  "unknown-thread": "That thread is archived or gone, so it cannot be shared.",
  full: "This computer already shares as many links as it can. Stop one first.",
  "unknown-link": "That link already ended.",
  "unknown-comment": "That comment is gone.",
  "taint-refused":
    "The thread could not be marked as carrying outside content, so nothing was sent.",
};

const SCOPE_COPY = { read: "Read only", comment: "Can comment" } as const;

/**
 * A visitor's text with its control and direction-override characters
 * replaced, so a comment cannot reorder or hide what the person reads before
 * Send. Line breaks and tabs stay. The CLI replaces the same characters.
 */
export function visitorText(text: string): string {
  return text.replace(/(?![\n\t])[\p{Cc}\u202A-\u202E\u2066-\u2069]/gu, "\uFFFD");
}

function until(at: number): string {
  return new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function VisitorLinkList(props: {
  readonly view: VisitorsView;
  readonly action: HubEntranceAction;
  readonly onChanged: () => Promise<void>;
  /** Names the thread a link shares, where the list mixes threads. */
  readonly threadLabel?: (link: VisitorLink) => string;
  /** Told once a link is stopped, so a caller showing it once can forget it. */
  readonly onStopped?: (linkId: string) => void;
  readonly now: number;
}) {
  const { view, action } = props;
  /** The framed comment Send handed back, until the person copies or closes it. */
  const [sent, setSent] = useState<string>();
  /** The request the person asked to dismiss, until they confirm or cancel. */
  const [dismissing, setDismissing] = useState<VisitorComment>();
  const dismissOpener = useRef<HTMLButtonElement>(null);
  const sentPanel = useRef<HTMLDivElement>(null);
  // Send removes the request's row, so focus goes to what it handed back.
  useEffect(() => {
    if (sent !== undefined) sentPanel.current?.focus();
  }, [sent]);

  const stop = async (link: VisitorLink) => {
    const body = await action.run(
      "visitor-stop",
      { linkId: link.linkId },
      "stopped",
      "Octant could not stop sharing that link.",
      VISITOR_REFUSALS,
    );
    if (body !== undefined) {
      props.onStopped?.(link.linkId);
      action.say({ kind: "success", text: "Stopped sharing. The link's next request is refused." });
    }
    await props.onChanged();
  };

  const decide = async (comment: VisitorComment, decision: "send" | "dismiss") => {
    const body = await action.run(
      "visitor-comment",
      { commentId: comment.commentId, action: decision },
      // The host dismisses instead of sending when the request's link is gone.
      decision === "send" ? ["sent", "dismissed"] : "dismissed",
      decision === "send" ? "Octant could not send that comment." : "Octant could not dismiss it.",
      VISITOR_REFUSALS,
    );
    const text = field(body, "text");
    if (decision === "send" && typeof text === "string") setSent(text);
    if (decision === "send" && field(body, "status") === "dismissed") {
      action.say({
        kind: "error",
        text: "Nothing was sent: the request's link no longer exists, so Octant dismissed it.",
      });
    }
    if (decision === "dismiss" && body !== undefined) {
      action.say({ kind: "success", text: "Dismissed. The visitor is not told." });
    }
    await props.onChanged();
  };

  const linkOf = (linkId: string) => view.links.find((link) => link.linkId === linkId);

  return (
    <>
      {sent === undefined ? null : (
        <div
          aria-label="Comment to send"
          className="settings-panel__stack"
          ref={sentPanel}
          role="group"
          tabIndex={-1}
        >
          <p className="setrow-hint">
            The thread now carries outside content. Send this as your next message there:
          </p>
          <pre className="setrow-hint hub-entrance__secret">{visitorText(sent)}</pre>
          <div className="host-settings__controls">
            <OctantButton
              onClick={() =>
                void copyToClipboard(visitorText(sent)).then((copied) =>
                  action.say(
                    copied
                      ? { kind: "success", text: "Comment copied." }
                      : {
                          kind: "error",
                          text: "The comment could not be copied. Select it instead.",
                        },
                  ),
                )
              }
              size="sm"
            >
              Copy comment
            </OctantButton>
            <OctantButton onClick={() => setSent(undefined)} size="sm" variant="secondary">
              Done
            </OctantButton>
          </div>
        </div>
      )}
      {view.comments.length === 0 ? null : (
        <ul aria-label="Visitor requests" className="setgroup">
          {view.comments.map((comment) => {
            const link = linkOf(comment.linkId);
            return (
              <li className="setrow hub-entrance__request" key={comment.commentId}>
                <span className="setrow-label">
                  {link === undefined || props.threadLabel === undefined
                    ? "Request from a visitor"
                    : `Request from a visitor on ${props.threadLabel(link)}`}
                </span>
                {/* A visitor wrote this; React writes it as text, never markup. */}
                <p className="setrow-hint hub-entrance__comment">{visitorText(comment.text)}</p>
                <p className="setrow-hint">{formatWhen(comment.at, props.now)}</p>
                <div className="setrow-control">
                  <OctantButton
                    aria-label={`Send the visitor's request: ${visitorText(comment.text).slice(0, 40)}`}
                    disabled={action.busy}
                    onClick={() => void decide(comment, "send")}
                    size="sm"
                  >
                    Send
                  </OctantButton>
                  <OctantButton
                    aria-label={`Dismiss the visitor's request: ${visitorText(comment.text).slice(0, 40)}`}
                    disabled={action.busy}
                    onClick={() => setDismissing(comment)}
                    ref={dismissing?.commentId === comment.commentId ? dismissOpener : undefined}
                    size="sm"
                    variant="secondary"
                  >
                    Dismiss…
                  </OctantButton>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {view.links.length === 0 ? (
        <SettingsState kind="empty">Nothing is shared with a visitor.</SettingsState>
      ) : (
        <ul aria-label="Visitor links" className="setgroup">
          {view.links.map((link) => (
            <li className="setrow" key={link.linkId}>
              <span className="setrow-label">
                {props.threadLabel === undefined ? SCOPE_COPY[link.scope] : props.threadLabel(link)}
              </span>
              <p className="setrow-hint">
                {[
                  ...(props.threadLabel === undefined ? [] : [SCOPE_COPY[link.scope]]),
                  `until ${until(link.expiresAt)}`,
                  link.opened ? "opened" : "not opened yet",
                ].join(" · ")}
              </p>
              <div className="setrow-control">
                <OctantButton
                  aria-label={`Stop sharing ${props.threadLabel?.(link) ?? "this link"}, ${SCOPE_COPY[link.scope].toLowerCase()}`}
                  disabled={action.busy}
                  onClick={() => void stop(link)}
                  size="sm"
                  variant="secondary"
                >
                  Stop sharing
                </OctantButton>
              </div>
            </li>
          ))}
        </ul>
      )}
      {view.published ? null : (
        <p className="setrow-hint">
          The hub has not taken the latest links yet; this computer tries again shortly.
        </p>
      )}
      <OctantDialogPresence>
        {dismissing === undefined ? null : (
          <OctantConfirmDialog
            confirmLabel="Dismiss request"
            destructive
            onCancel={() => setDismissing(undefined)}
            onConfirm={() => {
              const chosen = dismissing;
              setDismissing(undefined);
              void decide(chosen, "dismiss");
            }}
            restoreFocus={dismissOpener}
            title="Dismiss this request?"
          >
            Octant throws the visitor's request away without sending it to the thread. The visitor
            is not told, and it cannot be brought back.
          </OctantConfirmDialog>
        )}
      </OctantDialogPresence>
    </>
  );
}
