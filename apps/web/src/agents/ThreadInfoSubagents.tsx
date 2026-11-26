import { useContext, useMemo, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { ChevronRight } from "../ui/icons";
import { isActiveAgentHierarchyStatus } from "./buildAgentHierarchyModel";
import { SubagentStatusIcon, subagentStatusWord } from "./subagentStatus";
import { buildSubagentRows, type SubagentRow } from "./subagentRows";
import { ThreadSubagentOpenContext, ThreadSubagentsContext } from "./threadSubagents";
import "./thread-info-subagents.css";

/** How many earlier subagents the section lists before it folds the rest. */
const PREVIOUS_SHOWN = 5;

/**
 * The thread's subagents in its Thread info: those running now, then the
 * earlier ones, each opening as a thread of its own. It reads the one shared
 * read of the pane's subagents and shows nothing where the thread has none.
 */
export function ThreadInfoSubagents() {
  const subagents = useContext(ThreadSubagentsContext);
  const onOpen = useContext(ThreadSubagentOpenContext);
  const [showAll, setShowAll] = useState(false);
  const rows = useMemo(
    () =>
      subagents === undefined || subagents.status !== "ready"
        ? []
        : buildSubagentRows({
            entries: subagents.entries,
            observations: subagents.observations,
          }),
    [subagents],
  );
  if (rows.length === 0) return null;
  const running = rows.filter((row) => isActiveAgentHierarchyStatus(row.lifecycleStatus));
  const previous = rows.filter((row) => !isActiveAgentHierarchyStatus(row.lifecycleStatus));
  const shownPrevious = showAll ? previous : previous.slice(0, PREVIOUS_SHOWN);
  return (
    // Rows sit directly in the panel, so they are drawn as its other rows are.
    <>
      <p className="thread-info-subagents__heading">
        Subagents
        <span className="thread-info__value">
          {running.length === 0
            ? `${String(previous.length)} earlier`
            : `${String(running.length)} running`}
        </span>
      </p>
      {running.map((row) => (
        <SubagentInfoRow key={row.id} onOpen={onOpen} row={row} />
      ))}
      {previous.length === 0 ? null : (
        <p className="thread-info-subagents__group">
          Previous
          <span className="thread-info__value">{String(previous.length)}</span>
        </p>
      )}
      {shownPrevious.map((row) => (
        <SubagentInfoRow key={row.id} onOpen={onOpen} row={row} />
      ))}
      {previous.length > PREVIOUS_SHOWN && !showAll ? (
        <OctantButton onClick={() => setShowAll(true)} size="sm" type="button" variant="ghost">
          Show {String(previous.length - PREVIOUS_SHOWN)} more
        </OctantButton>
      ) : null}
    </>
  );
}

function SubagentInfoRow(props: {
  readonly row: SubagentRow;
  readonly onOpen: ((id: string) => void) | undefined;
}) {
  const row = props.row;
  const label = `${row.task}, ${subagentStatusWord(row.lifecycleStatus)}`;
  const content = (
    <>
      <SubagentStatusIcon lifecycleStatus={row.lifecycleStatus} />
      <span className="thread-info-subagents__task">{row.task}</span>
      <span className="thread-info__value">{row.model}</span>
    </>
  );
  if (props.onOpen === undefined) {
    return (
      <p aria-label={label} className="thread-info-subagents__row">
        {content}
      </p>
    );
  }
  const open = props.onOpen;
  return (
    <OctantButton
      aria-label={`Open ${label}`}
      onClick={() => open(row.id)}
      size="sm"
      type="button"
      variant="ghost"
    >
      {content}
      <ChevronRight aria-hidden="true" size={14} />
    </OctantButton>
  );
}
