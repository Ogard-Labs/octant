import { VISITOR_LINK_DEFAULT_LIFETIME_MS, VISITOR_LINK_MAX_LIFETIME_MS } from "@octant/contracts";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { SettingsState } from "../settings/primitives";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantDialog } from "../ui/base/OctantDialog";
import { OctantField, OctantFieldLabel } from "../ui/base/OctantField";
import { OctantSelectField } from "../ui/base/OctantSelect";
import {
  copyToClipboard,
  field,
  list,
  useHubEntranceAction,
  type HubRequest,
} from "./hubEntranceAction";
import { readVisitors, VISITOR_REFUSALS, VisitorLinkList, type VisitorsView } from "./VisitorLinks";

/**
 * Share with visitor, from the Computer card of a thread's Environment on the
 * computer that owns the thread: make a read-only or comment-only link with an expiry, see the link
 * once, stop sharing it, and answer the visitor's requests. The spoke signs
 * and checks every link; this dialog only asks it through the loopback hub
 * administration. Loaded as its own chunk (hub-and-spokes.md, Visitor links).
 */

const HOUR_MS = 60 * 60 * 1000;
const EXPIRY_CHOICES: ReadonlyArray<{
  readonly id: string;
  readonly label: string;
  readonly ms: number;
}> = [
  { id: "hour", label: "1 hour", ms: HOUR_MS },
  { id: "day", label: "1 day", ms: VISITOR_LINK_DEFAULT_LIFETIME_MS },
  { id: "week", label: "7 days", ms: VISITOR_LINK_MAX_LIFETIME_MS },
];

/**
 * The last good read stays beside a later failure: the list holds a sent
 * request's framed comment, which the host cannot hand out again.
 */
interface Loaded {
  readonly view?: VisitorsView;
  /** Where visitors reach this computer, when it is the hub and its Funnel says so. */
  readonly origin?: string | undefined;
  readonly error?: string | undefined;
}

/**
 * The hub's own public address from its status: Funnel serves the hub's
 * tailnet name, which the signed roster carries. Every other computer, and a
 * hub behind the person's own front, has no address a visitor could use here.
 */
function funnelOrigin(status: unknown): string | undefined {
  const hub = field(status, "hub");
  const entrance = field(status, "publicEntrance");
  const funnel = field(entrance, "funnel");
  const port = field(funnel, "port");
  if (
    field(hub, "enabled") !== true ||
    field(entrance, "enabled") !== true ||
    field(entrance, "paused") === true ||
    field(funnel, "enabled") !== true ||
    typeof port !== "number"
  ) {
    return undefined;
  }
  const self = list(field(field(field(hub, "roster"), "roster"), "members")).find(
    (member) => field(member, "role") === "hub",
  );
  const name = list(field(self, "privateNames")).find(
    (candidate): candidate is string =>
      typeof candidate === "string" && candidate.endsWith(".ts.net"),
  );
  if (name === undefined) return undefined;
  return port === 443 ? `https://${name}` : `https://${name}:${port}`;
}

export default function VisitorShareDialog(props: {
  readonly request: HubRequest;
  readonly mode: string;
  readonly threadId: string;
  readonly title: string;
  readonly onClose: () => void;
  readonly now?: () => number;
}) {
  const action = useHubEntranceAction(props.request);
  const [loaded, setLoaded] = useState<Loaded>({});
  const [scope, setScope] = useState<"read" | "comment">("read");
  const [expiry, setExpiry] = useState("day");
  const [shared, setShared] = useState<{
    readonly linkId: string;
    readonly url: string;
    readonly published: boolean;
  }>();
  const sharedPanel = useRef<HTMLDivElement>(null);
  // The link is shown once; focus goes to it so it is not missed.
  useEffect(() => {
    if (shared !== undefined) sharedPanel.current?.focus();
  }, [shared]);
  const titleId = useId();
  const scopeId = useId();
  const expiryId = useId();
  const { request, mode, threadId } = props;

  const refresh = useCallback(async () => {
    const failed = (error: string) => setLoaded((previous) => ({ ...previous, error }));
    try {
      const reply = await request("status");
      const view = reply.status === 200 ? readVisitors(field(reply.body, "visitors")) : undefined;
      if (view === undefined) {
        failed("This computer is not set up for visitor links. Join a hub and tick Public first.");
        return;
      }
      // Only this thread's links, and only the requests waiting on them.
      const links = view.links.filter((link) => link.mode === mode && link.threadId === threadId);
      const ids = new Set(links.map((link) => link.linkId));
      setLoaded({
        view: { ...view, links, comments: view.comments.filter((c) => ids.has(c.linkId)) },
        origin: funnelOrigin(reply.body),
      });
    } catch {
      failed("Octant could not read this computer's visitor links.");
    }
  }, [request, mode, threadId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const share = async () => {
    setShared(undefined);
    const lifetimeMs = EXPIRY_CHOICES.find((choice) => choice.id === expiry)?.ms;
    const body = await action.run(
      "visitor-share",
      {
        mode,
        threadId,
        scope,
        ...(lifetimeMs === undefined ? {} : { lifetimeMs }),
      },
      "shared",
      "Octant could not share this thread.",
      VISITOR_REFUSALS,
    );
    const url = field(body, "url");
    const linkId = field(body, "linkId");
    if (typeof url === "string" && typeof linkId === "string") {
      setShared({ linkId, url, published: field(body, "published") === true });
    }
    await refresh();
  };

  // What the person copies: the whole link where the address is known, else
  // the path the host answered, named as one.
  const address =
    shared === undefined
      ? undefined
      : loaded.origin === undefined
        ? { text: shared.url, noun: "path" }
        : { text: `${loaded.origin}${shared.url}`, noun: "link" };

  return (
    <OctantDialog
      className="project-dialog hub-entrance-dialog"
      label="Share with visitor"
      labelledBy={titleId}
      onClose={props.onClose}
      open
      popupId="visitor-share-dialog"
    >
      <div className="project-dialog__header">
        <h1 id={titleId}>Share with visitor</h1>
      </div>
      <p>
        {`Give someone outside your computers a link to “${props.title}”. They see its messages and state, never tool output, files or approvals.`}
      </p>
      <OctantField>
        <OctantFieldLabel htmlFor={scopeId}>Visitor may</OctantFieldLabel>
        <OctantSelectField
          id={scopeId}
          onValueChange={(value) => {
            if (value === "read" || value === "comment") setScope(value);
          }}
          options={[
            { id: "read", label: "Read only" },
            { id: "comment", label: "Read and send requests" },
          ]}
          value={scope}
        />
      </OctantField>
      <OctantField>
        <OctantFieldLabel htmlFor={expiryId}>Link ends after</OctantFieldLabel>
        <OctantSelectField
          id={expiryId}
          onValueChange={setExpiry}
          options={EXPIRY_CHOICES.map((choice) => ({ id: choice.id, label: choice.label }))}
          value={expiry}
        />
      </OctantField>
      <div className="project-dialog__actions">
        <OctantButton onClick={props.onClose} type="button" variant="outline">
          Close
        </OctantButton>
        <OctantButton
          disabled={action.busy || loaded.view === undefined || loaded.error !== undefined}
          onClick={() => void share()}
          type="button"
        >
          Make link
        </OctantButton>
      </div>
      {shared === undefined || address === undefined ? null : (
        <div
          aria-label="New visitor link"
          className="settings-panel__stack"
          ref={sharedPanel}
          role="group"
          tabIndex={-1}
        >
          <p className="setrow-hint">
            {address.noun === "link"
              ? "Link on your hub's public address. The part after # is its secret; Octant does not show it again, so send the whole link now."
              : "This is the link's path, not a whole link. Put your hub's public address in front of it and send the whole link now. The part after # is its secret; Octant does not show it again."}
          </p>
          <code className="hub-entrance__secret">{address.text}</code>
          <div className="host-settings__controls">
            <OctantButton
              onClick={() =>
                void copyToClipboard(address.text).then((copied) =>
                  action.say(
                    copied
                      ? {
                          kind: "success",
                          text: address.noun === "link" ? "Link copied." : "Path copied.",
                        }
                      : {
                          kind: "error",
                          text: `The ${address.noun} could not be copied. Select it instead.`,
                        },
                  ),
                )
              }
              size="sm"
            >
              {`Copy ${address.noun}`}
            </OctantButton>
          </div>
          {shared.published ? null : (
            <p className="setrow-hint">
              The hub has not taken the link yet; this computer tries again shortly.
            </p>
          )}
        </div>
      )}
      {action.notice === undefined ? null : (
        <SettingsState kind={action.notice.kind}>{action.notice.text}</SettingsState>
      )}
      {loaded.view === undefined && loaded.error === undefined ? (
        <SettingsState kind="loading">Reading this thread's links…</SettingsState>
      ) : null}
      {loaded.error === undefined ? null : (
        <SettingsState kind="error">{loaded.error}</SettingsState>
      )}
      {loaded.view === undefined ? null : (
        <VisitorLinkList
          action={action}
          now={(props.now ?? Date.now)()}
          onChanged={refresh}
          onStopped={(linkId) =>
            setShared((current) => (current?.linkId === linkId ? undefined : current))
          }
          view={loaded.view}
        />
      )}
    </OctantDialog>
  );
}
