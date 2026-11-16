import { useEffect, useMemo, useState } from "react";
import type { AgentRunClient } from "@octant/client-runtime/agent-run-client";
import { decodeAgentRunParentThreadId } from "@octant/contracts/agent-run";
import { Bot } from "../ui/icons";
import { useChildRunStatus } from "../agents/useChildRunStatus";
import {
  isActiveAgentHierarchyStatus,
  subagentNeedsReview,
  type AgentHierarchyInputEntry,
} from "../agents/buildAgentHierarchyModel";
import {
  SubagentStatusIcon,
  subagentElapsedLabel,
  subagentStatusWord,
} from "../agents/subagentStatus";
import type { SubagentProviderIdentity } from "../agents/AgentRunDependencyGraph";
import { useNow } from "../agents/ComposerSubagentsTray";
import { buildSubagentRows, type SubagentRow } from "../agents/subagentRows";
import { SubagentProviderMark, useSubagentProviders } from "../agents/subagentProviders";
import { OctantButton } from "../ui/base/OctantButton";
import { EnvironmentGroup } from "./EnvironmentGroup";

/** Running rows shown before "+N more"; the Agents tool holds the rest. */
const MAX_RUNNING_ROWS = 5;

/**
 * The thread's subagents as one Environment row. It opens by itself while any
 * run is working, one compact row per running run (the provider's mark, the
 * title, how long it has run), then one quiet "N finished" line. A row opens
 * that run in the Agents tool and "N finished" and "+N more" open the tool
 * itself, where a finished run is read again and every control stays: the
 * strip offers no Stop, because stopping a run is the Agents tool's and the
 * composer card's action.
 *
 * The provider and model of a run are only what the host reported for it. The
 * strip is 300px wide, so the model is in the row's tooltip and name, not in
 * its text.
 */
export function EnvironmentSubagents(props: {
  readonly client: AgentRunClient;
  readonly threadId: string;
  readonly onOpenAgents?: (runId?: string) => void;
  /** Provider instances by id; the app's own when omitted. */
  readonly providers?: ReadonlyMap<string, SubagentProviderIdentity>;
}) {
  const controller = useChildRunStatus({
    client: props.client,
    parentThreadId: decodeAgentRunParentThreadId(props.threadId),
  });
  const providers = useSubagentProviders(props.providers);
  const rows = useMemo(
    () =>
      new Map(
        buildSubagentRows({
          entries: controller.entries,
          ...(providers === undefined ? {} : { providers }),
        }).map((row) => [row.id, row]),
      ),
    [controller.entries, providers],
  );
  // A row that vanished when nothing had been delegated could not be told
  // apart from a missing feature, so an empty thread says None.
  const summary = controller.status !== "ready" ? "Reading" : subagentSummary(controller.entries);
  const working = controller.entries.filter((entry) =>
    isActiveAgentHierarchyStatus(entry.lifecycleStatus),
  );
  const ended = controller.entries.filter(
    (entry) => !isActiveAgentHierarchyStatus(entry.lifecycleStatus),
  );
  // A run that ended and waits to be read is not the same news as one that is
  // simply done, so it is counted on a line of its own.
  const toReview = ended.filter((entry) => subagentNeedsReview(entry)).length;
  const finished = ended.length - toReview;
  const shown = working.slice(0, MAX_RUNNING_ROWS);
  // Opens with the first run and then stays as the person left it. Following
  // the work both ways closed the group by itself when the last run ended:
  // five rows gone at once, and the result line with them.
  const [chosen, setChosen] = useState<boolean>();
  const [hadWork, setHadWork] = useState(false);
  useEffect(() => {
    if (working.length > 0) setHadWork(true);
  }, [working.length]);
  const open = chosen ?? (working.length > 0 || hadWork);
  // The clock runs only while a row that shows it is on screen.
  const now = useNow(open && shown.length > 0);

  return (
    <EnvironmentGroup
      icon={Bot}
      onOpenChange={setChosen}
      open={open}
      summary={summary}
      title="Subagents"
    >
      {/* Before the first read answers the list is empty but unknown; saying
          None there hid runs that existed and contradicted the header. */}
      {controller.status !== "ready" ? (
        <p className="environment-subagents__empty" role="status">
          Reading subagents…
        </p>
      ) : controller.entries.length === 0 ? (
        <p className="environment-subagents__empty">
          None yet. They appear when the agent hands off part of its work.
        </p>
      ) : (
        <div className="environment-subagents__list">
          {shown.map((entry) => (
            <RunningRow
              entry={entry}
              key={entry.runId}
              now={now}
              row={rows.get(String(entry.runId))}
              {...(props.onOpenAgents === undefined ? {} : { onOpen: props.onOpenAgents })}
            />
          ))}
          {working.length > shown.length && props.onOpenAgents !== undefined ? (
            <QuietLine
              label={`+${String(working.length - shown.length)} more`}
              onClick={() => props.onOpenAgents?.()}
            />
          ) : null}
          {toReview === 0 || props.onOpenAgents === undefined ? null : (
            <QuietLine
              label={`${String(toReview)} to review`}
              onClick={() => props.onOpenAgents?.()}
            />
          )}
          {finished === 0 || props.onOpenAgents === undefined ? null : (
            <QuietLine
              label={`${String(finished)} finished`}
              onClick={() => props.onOpenAgents?.()}
            />
          )}
        </div>
      )}
    </EnvironmentGroup>
  );
}

function QuietLine(props: { readonly label: string; readonly onClick: () => void }) {
  return (
    <OctantButton
      className="environment-subagent window-no-drag"
      onClick={props.onClick}
      type="button"
      variant="link"
    >
      <span aria-hidden="true" className="environment-subagents__slot" />
      <span className="environment-subagents__state">{props.label}</span>
    </OctantButton>
  );
}

function RunningRow(props: {
  readonly entry: AgentHierarchyInputEntry;
  readonly row: SubagentRow | undefined;
  readonly now: number;
  readonly onOpen?: (runId: string) => void;
}) {
  const { entry, row } = props;
  // Only what the host reported for this run: a run with no route names no
  // provider and no model, never its parent's.
  const reported = entry.route !== undefined && row !== undefined;
  const ranOn = reported ? [row.providerName, row.model] : [];
  const word = subagentNeedsReview(entry) ? "To review" : subagentStatusWord(entry.lifecycleStatus);
  // Time is shown only when the host says when the run began; otherwise the
  // state word the Agents list shows.
  const elapsed =
    entry.createdAt === undefined ? "" : subagentElapsedLabel(entry.createdAt, props.now);
  const trailing = elapsed === "" ? word : elapsed;
  const content = (
    <>
      {reported && row.driverKind !== undefined ? (
        <SubagentProviderMark
          className="environment-subagents__mark"
          driverKind={row.driverKind}
          providerName={row.providerName}
          size={14}
        />
      ) : (
        <SubagentStatusIcon lifecycleStatus={entry.lifecycleStatus} />
      )}
      <span className="environment-subagents__task">{entry.task}</span>
      <span className="environment-subagents__state">{trailing}</span>
    </>
  );
  const title = [entry.task, ...ranOn].join(" · ");
  const name = `${entry.task}. ${[...ranOn, elapsed === "" ? word : `${word}, ${elapsed}`].join(", ")}`;
  return props.onOpen === undefined ? (
    <span className="environment-subagent" title={title}>
      {content}
    </span>
  ) : (
    <OctantButton
      aria-label={`${name}. Open in Agents`}
      className="environment-subagent window-no-drag"
      onClick={() => props.onOpen?.(String(entry.runId))}
      title={title}
      type="button"
      variant="link"
    >
      {content}
    </OctantButton>
  );
}

/** "1 working · 2 to review", in the order a reader acts on them. */
export function subagentSummary(entries: ReadonlyArray<AgentHierarchyInputEntry>): string {
  if (entries.length === 0) return "None";
  let working = 0;
  let toReview = 0;
  let done = 0;
  for (const entry of entries) {
    if (isActiveAgentHierarchyStatus(entry.lifecycleStatus)) working += 1;
    else if (subagentNeedsReview(entry)) toReview += 1;
    else done += 1;
  }
  const parts: string[] = [];
  if (working > 0) parts.push(`${String(working)} working`);
  if (toReview > 0) parts.push(`${String(toReview)} to review`);
  if (done > 0) parts.push(`${String(done)} done`);
  return parts.join(" · ");
}
