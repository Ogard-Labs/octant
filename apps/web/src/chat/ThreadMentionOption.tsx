import type { ThreadMentionCandidate } from "@octant/contracts";
import { ProjectMark } from "../projects/ProjectMark";
import { threadModelName } from "../projects/threadEngine";
import { threadRowShortAge } from "../projects/threadRowShortAge";
import { threadRowState } from "../projects/threadRowState";
import { ProviderGlyph } from "../providers/ProviderGlyph";
import { threadRowActivity } from "../shell/navigationModel";
import { threadModeLabel } from "../threadReferences/threadModeLabel";
import { useThreadReferences } from "../threadReferences/ThreadReferences";
import { Hash } from "../ui/icons";
import { threadPlacementLabel } from "./threadPlacementLabel";
import "./thread-mention-option.css";

/**
 * One hit, with the facts this window already lists about its thread: the
 * Project's mark, what it runs, and whether it works or waits on the person. A
 * thread the window does not list shows what the host's search said.
 */
export function ThreadMentionOption(props: { readonly candidate: ThreadMentionCandidate }) {
  const { candidate } = props;
  const reference = useThreadReferences().find(String(candidate.threadId));
  const thread = reference?.thread;
  const state =
    thread === undefined
      ? undefined
      : threadRowState({
          activity: threadRowActivity(thread),
          unread: false,
          woke: false,
          startedAt: thread.turnStartedAt,
        }).state;
  const model = thread === undefined ? undefined : threadModelName(thread);
  const age = threadRowShortAge(candidate.updatedAt);
  return (
    <>
      {reference?.projectName === undefined || thread?.projectId === undefined ? (
        <span className="thread-mention__mark">
          <Hash aria-hidden="true" size={12} />
        </span>
      ) : (
        <ProjectMark name={reference.projectName} projectId={thread.projectId} />
      )}
      <span className="thread-mention__title">{candidate.title}</span>
      <span className="thread-mention__meta">
        {state === undefined ? null : (
          <span className="thread-mention__state" data-status={state.status}>
            {state.text}
          </span>
        )}
        {thread?.provider === undefined ? null : (
          <span className="thread-mention__engine">
            <ProviderGlyph
              displayName={thread.provider.displayName}
              driverKind={thread.provider.driverKind}
              size={12}
            />
            {model ?? thread.provider.displayName}
          </span>
        )}
        <span>
          {`${threadModeLabel(candidate.mode)} · ${threadPlacementLabel(candidate.placement)}`}
        </span>
        {state !== undefined || age === undefined ? null : <span>{age}</span>}
      </span>
    </>
  );
}
