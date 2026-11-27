import { SettingsSection, SettingsState } from "../settings/primitives";
import { OctantSwitch } from "../ui/base/OctantSwitch";
import { useHubEntranceAction, type HubRequest } from "./hubEntranceAction";
import { readVisitors, VisitorLinkList, type VisitorLink } from "./VisitorLinks";

/**
 * Settings › Public entrance › Visitor links: on the hub, the switch that lets
 * its public entrance serve visitor links; on a member, every link this
 * computer shares and the visitor requests waiting on them. A thread is
 * shared from Share with visitor on its Environment's Computer card. Loaded
 * as its own chunk (hub-and-spokes.md, Visitor links).
 */

const MODE_NAMES: Readonly<Record<string, string>> = { chat: "Chat", code: "Code", work: "Work" };

// A thread this window has no title for (archived, or not loaded here) reads
// by its kind and the start of its id.
function threadLabel(link: VisitorLink, titles: ReadonlyMap<string, string>): string {
  return (
    titles.get(`${link.mode}:${link.threadId}`) ??
    `${MODE_NAMES[link.mode] ?? link.mode} thread ${link.threadId.slice(0, 8)}`
  );
}

const NO_TITLES: ReadonlyMap<string, string> = new Map();

export default function HubVisitorLinksSection(props: {
  readonly request: HubRequest;
  /** The status body's `visitors` part, read here so the parsing loads with this chunk. */
  readonly body: unknown;
  readonly hubOn: boolean;
  readonly member: boolean;
  readonly onChanged: () => Promise<void>;
  readonly now?: () => number;
  /** Thread titles by `mode:threadId`. */
  readonly threadTitles?: ReadonlyMap<string, string>;
}) {
  const view = readVisitors(props.body);
  const action = useHubEntranceAction(props.request);
  if (view === undefined) return null;

  const setLinks = async (on: boolean) => {
    const body = await action.run(
      "visitors",
      { enabled: on },
      "changed",
      on ? "Octant could not turn visitor links on." : "Octant could not turn visitor links off.",
    );
    if (body !== undefined) {
      action.say({
        kind: "success",
        text: on
          ? "Visitor links are on. A member's link opens only once that member shares a thread."
          : "Visitor links are off. Every visitor route answers nothing.",
      });
    }
    await props.onChanged();
  };

  return (
    <SettingsSection
      description="Show a visitor one thread, read only or with comments, through the hub's public entrance."
      title="Visitor links"
    >
      {!props.hubOn || view.hub === undefined ? null : (
        <div className="setgroup">
          <div className="setrow">
            <span className="setrow-label">Visitor links</span>
            <p className="setrow-hint">
              {view.hub.enabled
                ? `Serve the links members share. Holding ${view.hub.grants} link${view.hub.grants === 1 ? "" : "s"}; ${view.hub.streams} open now.`
                : "Serve the links members share. Off by default."}
            </p>
            <div className="setrow-control">
              <OctantSwitch
                checked={view.hub.enabled}
                disabled={action.busy}
                label="Visitor links"
                onCheckedChange={(on) => void setLinks(on)}
              />
            </div>
          </div>
        </div>
      )}
      {!props.member ? null : (
        <>
          <p className="setrow-hint">
            Share a thread from Share with visitor in its Environment. A visitor sees its messages
            and state, never tool output, files or approvals.
          </p>
          <VisitorLinkList
            action={action}
            now={(props.now ?? Date.now)()}
            onChanged={props.onChanged}
            threadLabel={(link) => threadLabel(link, props.threadTitles ?? NO_TITLES)}
            view={view}
          />
        </>
      )}
      {action.notice === undefined ? null : (
        <SettingsState kind={action.notice.kind}>{action.notice.text}</SettingsState>
      )}
    </SettingsSection>
  );
}
