import { useThreadSideTasks } from "../followUps/SideTaskCards";
import { LazyThreadReferenceChip } from "../threadReferences/LazyThreadReferenceChip";
import {
  parseSideTaskReportDelivery,
  type SideTaskReportCardBlock,
} from "./sideTaskReportDelivery";
import { FoldedText } from "./ChildResultCards";
import "./agent-hierarchy.css";

const OUTCOME_WORDS = {
  completed: "finished",
  failed: "failed",
  cancelled: "cancelled",
} as const;

/**
 * A side-task child's ended turn, as the offering thread received it. The
 * host delivers the report as a turn so the parent agent can act on it, but
 * the person did not write it: it is attributed to the side task and its
 * outcome, left-aligned like any other reply, never drawn as the person's
 * own right-aligned message. Callers render this only for a turn whose
 * journaled delivery mark says `side-task-report`; the text alone is never
 * treated as proof a report was delivered.
 */
export function SideTaskReportCards(props: { readonly text: string }) {
  const blocks = parseSideTaskReportDelivery(props.text);
  return (
    <div className="child-results">
      {blocks.map((block, index) => (
        <SideTaskReportCard block={block} key={index} />
      ))}
    </div>
  );
}

function SideTaskReportCard(props: { readonly block: SideTaskReportCardBlock }) {
  const block = props.block;
  if (block.kind === "raw") {
    return (
      <article aria-label="Report from side task" className="child-result">
        <header className="child-result__head">
          <span className="child-result__title">Report from side task</span>
        </header>
        <FoldedText text={block.text} />
      </article>
    );
  }
  return (
    <article aria-label="Report from side task" className="child-result">
      <header className="child-result__head">
        <span className="child-result__title">Report from side task</span>
        <span className="child-result__attribution">
          <ReportedTaskTitle title={block.title} /> · {OUTCOME_WORDS[block.outcome]}
        </span>
      </header>
      {block.text === undefined ? (
        <p className="child-result__note">
          {block.outcome === "completed" ? "The turn ended without a reply." : "No reply was kept."}
        </p>
      ) : (
        <FoldedText markdown text={block.text} />
      )}
      {block.truncated ? <p className="child-result__note">The reply was cut short.</p> : null}
    </article>
  );
}

/**
 * The task's name, opening the card of the thread it started. A report names
 * its task by title alone, so the thread is the one the pane's side tasks
 * started under that title. Where two share it, or none is listed, the name
 * stays text rather than pointing at a thread that may not have reported.
 */
function ReportedTaskTitle(props: { readonly title: string }) {
  const started = useThreadSideTasks().flatMap((task) =>
    task.offer.title === props.title && task.startedThreadId !== undefined
      ? [String(task.startedThreadId)]
      : [],
  );
  const [threadId] = started;
  if (threadId === undefined || started.length > 1) return props.title;
  return <LazyThreadReferenceChip look="link" threadId={threadId} title={props.title} />;
}
