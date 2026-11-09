import type { ReceivedHandoverView } from "@octant/contracts";
import { GitBranchPlus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantSelectField } from "../ui/base/OctantSelect";
import type { ThreadMoveClient } from "../environment/threadMove/threadMoveClient";
import type { HomeCardContent, HomeCardDefinition } from "./homeCards";

export const HANDOVERS_CARD_ID = "handovers";

/**
 * A notice only changes the host's state, and nothing tells an open start
 * screen, so the card reads again now and then and whenever the window comes
 * back to the front.
 */
export const HANDOVERS_REFRESH_MS = 30_000;

export interface HandoversCardSource {
  /** The move routes; absent outside a local desktop window, which hides the card. */
  readonly client: ThreadMoveClient | undefined;
  /** Opens the Code thread a continued handover became. */
  readonly onOpenThread: (threadId: string) => void;
}

/**
 * Handovers other computers told this one about: work committed and pushed to
 * a branch because its thread could not move. Continue handover is the
 * person's act; it opens a Code thread on the branch. Canonical:
 * docs/design/hub-and-spokes.md "Handover".
 */
export function createHandoversCard(source: HandoversCardSource): HomeCardDefinition {
  return {
    id: HANDOVERS_CARD_ID,
    title: "Handovers",
    icon: GitBranchPlus,
    defaultOn: true,
    available: source.client !== undefined,
    hideWhenEmpty: true,
    emptyLabel: "No handovers.",
    useContent: () => useHandoversContent(source),
  };
}

function useHandoversContent(source: HandoversCardSource): HomeCardContent {
  const [handovers, setHandovers] = useState<ReadonlyArray<ReceivedHandoverView> | undefined>(
    undefined,
  );
  const client = source.client;
  const load = useCallback(() => {
    if (client === undefined) return;
    client
      .handoversList()
      .then((listed) => setHandovers(listed.handovers))
      .catch(() => setHandovers([]));
  }, [client]);
  useEffect(() => {
    load();
    const timer = setInterval(load, HANDOVERS_REFRESH_MS);
    window.addEventListener("focus", load);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", load);
    };
  }, [load]);
  if (handovers === undefined) return { status: "loading" };
  return {
    status: "ready",
    count: handovers.length,
    body: (
      <ul className="handovers-card">
        {handovers.map((handover) => (
          <HandoverRow
            client={client}
            handover={handover}
            key={String(handover.handoverId)}
            onContinued={(threadId) => {
              load();
              source.onOpenThread(threadId);
            }}
          />
        ))}
      </ul>
    ),
  };
}

const REFUSALS: Readonly<Record<string, string>> = {
  refused: "This handover is no longer here.",
  "no-eligible-project": "No Code Project here is bound to that repository.",
  "no-matching-provider": "This computer has no provider of the kind the thread ran on.",
  "transfer-failed": "The branch or its note couldn't be fetched.",
};

function HandoverRow(props: {
  readonly handover: ReceivedHandoverView;
  readonly client: ThreadMoveClient | undefined;
  readonly onContinued: (threadId: string) => void;
}) {
  const { handover } = props;
  // The eligible Projects change as the card reads again, so the choice is
  // worked out from them each time: the person's pick while it is still
  // eligible, otherwise the one Project when exactly one fits.
  const [chosen, setChosen] = useState<string | undefined>(undefined);
  const eligible = handover.projects.map((choice) => String(choice.projectId));
  const project =
    chosen !== undefined && eligible.includes(chosen)
      ? chosen
      : eligible.length === 1
        ? eligible[0]
        : undefined;
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [working, setWorking] = useState(false);
  const continueHandover = async () => {
    if (props.client === undefined || project === undefined) return;
    setWorking(true);
    setProblem(undefined);
    try {
      const answer = await props.client.handoversContinue({
        handoverId: handover.handoverId,
        projectId: project,
      });
      if (answer.status === "continued") props.onContinued(answer.thread.threadId);
      else setProblem(REFUSALS[answer.reason] ?? "This handover couldn't be continued.");
    } catch {
      setProblem("This computer could not continue the handover.");
    } finally {
      setWorking(false);
    }
  };
  return (
    <li className="handovers-card__row">
      <div className="handovers-card__text">
        <span className="handovers-card__title">{handover.title}</span>
        <span className="handovers-card__meta">
          From {handover.originName} · <code>{handover.branch}</code>
        </span>
      </div>
      {handover.projects.length > 1 ? (
        <OctantSelectField
          aria-label={`Project for ${handover.title}`}
          onValueChange={setChosen}
          options={handover.projects.map((choice) => ({
            id: String(choice.projectId),
            label: choice.title,
          }))}
          placeholder="Choose a Project"
          value={project ?? ""}
        />
      ) : null}
      <OctantButton
        disabled={project === undefined || working}
        onClick={() => void continueHandover()}
        size="sm"
        variant="outline"
      >
        Continue handover
      </OctantButton>
      {handover.projects.length === 0 ? (
        <p className="handovers-card__problem">{REFUSALS["no-eligible-project"]}</p>
      ) : null}
      {problem === undefined ? null : (
        <p aria-live="polite" className="handovers-card__problem">
          {problem}
        </p>
      )}
    </li>
  );
}
