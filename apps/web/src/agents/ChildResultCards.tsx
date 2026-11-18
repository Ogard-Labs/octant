import type { AgentResultSteeredIntoTurn } from "@octant/contracts";
import type { PickerGroup } from "@octant/domain";
import { useContext, useId, useState, type ReactNode } from "react";
import { ChatRichText } from "../chat/ChatRichText";
import { modelDisplayName } from "../providers/providerModelLabel";
import { OctantButton } from "../ui/base/OctantButton";
import { ResultDisclosure } from "./AgentRunResults";
import "./agent-hierarchy.css";
import { parseChildResultDelivery, type ChildResultBlock } from "./childResultDelivery";
import { SubagentStatusIcon, subagentRoleWord, subagentStatusWord } from "./subagentStatus";
import { buildSubagentRows, subagentRunTime } from "./subagentRows";
import { isActiveAgentHierarchyStatus } from "./buildAgentHierarchyModel";
import { ThreadSubagentsContext } from "./threadSubagents";

/** Past this, a result starts folded so one child cannot push the thread away. */
const FOLD_AFTER_CHARACTERS = 600;
const FOLD_AFTER_LINES = 8;

/**
 * A finished subagent's result, as the parent thread received it.
 *
 * The host delivers a result into the parent as a turn so the parent agent can
 * act on it, but the person did not write it: it is attributed to the child
 * (role, provider, model) and left-aligned like any other reply, never drawn as
 * the person's own right-aligned message. Run and provider ids, which are for
 * support and for addressing the run, sit behind Details.
 */
export function ChildResultCards(props: {
  readonly text: string;
  readonly providerGroups?: ReadonlyArray<PickerGroup> | undefined;
}) {
  const parsed = parseChildResultDelivery(props.text);
  const blocks: ReadonlyArray<ChildResultBlock> =
    parsed.length === 0 ? [{ kind: "raw", text: props.text }] : parsed;
  return (
    <div className="child-results">
      {blocks.map((block, index) => (
        <ChildResultCard
          block={block}
          // The delivery is immutable text, so a block's position is its identity.
          key={index}
          providerGroups={props.providerGroups}
        />
      ))}
    </div>
  );
}

function ChildResultCard(props: {
  readonly block: ChildResultBlock;
  readonly providerGroups: ReadonlyArray<PickerGroup> | undefined;
}) {
  const block = props.block;
  if (block.kind === "raw") {
    return (
      <article aria-label="Subagent result" className="child-result">
        <header className="child-result__head">
          <span className="child-result__title">Subagent result</span>
        </header>
        <FoldedText text={block.text} />
      </article>
    );
  }
  const finished = block.outcome === "finished";
  const lifecycle = finished ? "completed" : (block.status ?? "failed");
  const role = subagentRoleWord(block.role);
  const state = finished ? "finished" : subagentStatusWord(lifecycle).toLowerCase();
  const providerName = props.providerGroups?.find(
    (group) => String(group.instance.id) === block.providerInstanceId,
  )?.instance.displayName;
  const model =
    props.providerGroups === undefined
      ? block.modelId
      : modelDisplayName(props.providerGroups, {
          providerInstanceId: block.providerInstanceId,
          modelId: block.modelId,
        });
  const attribution = [providerName, model].filter((part) => part !== undefined).join(" · ");
  const card = (
    <article
      aria-label={`${role} subagent ${state}`}
      className="child-result"
      data-outcome={finished ? "finished" : "stopped"}
    >
      <header className="child-result__head">
        <SubagentStatusIcon lifecycleStatus={lifecycle} />
        <span className="child-result__title">
          {role} subagent {state}
        </span>
        <span className="child-result__attribution">{attribution}</span>
      </header>
      <p className="child-result__task">{block.task}</p>
      {finished ? (
        block.text === undefined ? (
          <p className="child-result__note">The reply was not kept.</p>
        ) : (
          <FoldedText markdown text={block.text} />
        )
      ) : (
        <p className="child-result__note">{block.text ?? "No reason was recorded."}</p>
      )}
      {block.truncated ? <p className="child-result__note">The reply was cut short.</p> : null}
      <ResultDisclosure label="Details">
        <p>
          Run: <code>{block.runId}</code> · Generation {block.generation}
        </p>
        <p>
          Provider ID: <code>{block.providerInstanceId}</code> · Model: <code>{block.modelId}</code>
        </p>
      </ResultDisclosure>
    </article>
  );
  return finished ? (
    <FinishedResult generation={block.generation} role={role} runId={block.runId}>
      {card}
    </FinishedResult>
  ) : (
    card
  );
}

/**
 * A finished child's delivered result as one quiet line with its run time; the
 * card with the reply opens in place behind Show result. A child that stopped
 * or failed keeps the card, because that is news the person should see.
 */
function FinishedResult(props: {
  readonly role: string;
  readonly runId: string;
  readonly generation: string;
  readonly children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const subagents = useContext(ThreadSubagentsContext);
  const entry =
    subagents?.status === "ready"
      ? subagents.entries.find((candidate) => candidate.runId === props.runId)
      : undefined;
  // Only a child that has stopped has a settled time; a later generation that
  // is working again would tick a time this line cannot stand behind.
  // The run's times span every generation, so a later generation's delivery
  // cannot say how long that generation alone worked.
  const row =
    entry === undefined ||
    isActiveAgentHierarchyStatus(entry.lifecycleStatus) ||
    props.generation !== "1"
      ? undefined
      : buildSubagentRows({ entries: [entry] })[0];
  const ran = row === undefined ? "" : subagentRunTime(row, 0);
  return (
    <div className="child-result-quiet">
      <p className="child-result-quiet__line">
        <span>
          {props.role} subagent finished{ran === "" ? "" : ` · worked ${ran}`}
        </span>
        <OctantButton
          aria-controls={id}
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          size="xs"
          type="button"
          variant="ghost"
        >
          {open ? "Hide result" : "Show result"}
        </OctantButton>
      </p>
      <div hidden={!open} id={id}>
        {open ? props.children : null}
      </div>
    </div>
  );
}

function FoldedText(props: { readonly text: string; readonly markdown?: boolean }) {
  const long =
    props.text.length > FOLD_AFTER_CHARACTERS || props.text.split("\n").length > FOLD_AFTER_LINES;
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="child-result__text-frame">
      <div className="child-result__text" data-folded={long && !open ? "true" : "false"} id={id}>
        {props.markdown === true ? <ChatRichText body={props.text} /> : <p>{props.text}</p>}
      </div>
      {long ? (
        <OctantButton
          aria-controls={id}
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          size="xs"
          type="button"
          variant="ghost"
        >
          {open ? "Show less" : "Show full result"}
        </OctantButton>
      ) : null}
    </div>
  );
}

/**
 * Finished subagents' results the host steered into a turn while it ran. The
 * parent agent read them mid-turn rather than in a turn of their own, so they
 * sit inside that turn, after its reply, and say so; the cards are the same a
 * queued delivery shows.
 */
export function SteeredChildResults(props: {
  readonly steered: ReadonlyArray<AgentResultSteeredIntoTurn> | undefined;
  readonly providerGroups?: ReadonlyArray<PickerGroup> | undefined;
}) {
  if (props.steered === undefined || props.steered.length === 0) return null;
  return (
    <>
      {props.steered.map((entry) => (
        <article
          aria-label="Subagent results delivered into the running turn"
          className="turn-child-result"
          data-steered="true"
          key={`${String(entry.delivery.runId)}:${entry.steeredAt}`}
        >
          <p className="oct-meta child-result__steered">Delivered into the running turn</p>
          <ChildResultCards providerGroups={props.providerGroups} text={entry.body} />
        </article>
      ))}
    </>
  );
}
