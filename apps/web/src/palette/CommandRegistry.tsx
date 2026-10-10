import type { PendingRequest } from "@octant/contracts/pending-requests";
import { createContext, useContext, type ReactNode } from "react";
import type { CommandThread } from "./buildOctantCommands";
import type { OctantCommand } from "./commandModel";
import type {
  ApprovalDecision,
  ApprovalPendingRequest,
  DecisionPendingRequest,
} from "./needsYouCommands";

const NO_COMMANDS: ReadonlyArray<OctantCommand> = [];

const OctantCommandContext = createContext<ReadonlyArray<OctantCommand>>(NO_COMMANDS);

/**
 * Publishes the host-derived command list to every surface that offers
 * commands. It is mounted once, at the App level, next to the state the
 * commands close over.
 */
export function OctantCommandProvider(props: {
  readonly commands: ReadonlyArray<OctantCommand>;
  readonly children: ReactNode;
}) {
  return (
    <OctantCommandContext.Provider value={props.commands}>
      {props.children}
    </OctantCommandContext.Provider>
  );
}

/**
 * The commands this host offers right now. Without a provider — an isolated
 * component test, or a surface mounted outside the shell — the answer is an
 * empty list, and the consuming surface offers no command affordance at all
 * rather than an entry that would do nothing.
 */
export function useOctantCommands(): ReadonlyArray<OctantCommand> {
  return useContext(OctantCommandContext);
}

/**
 * What the palette needs to open on the agents waiting for the person: the
 * last read of the host's pending requests, a way to read it again, and the
 * callbacks a row runs. It is offered only to the palette — the `/` composer
 * affordance has no use for rows that open a thread or answer a request — and
 * only by a host that can read the list at all, so without a provider the
 * palette has no Needs you group.
 */
export interface NeedsYouSource {
  readonly requests: ReadonlyArray<PendingRequest>;
  /** Read the list again. The palette calls it each time it opens; nothing polls. */
  readonly refresh: () => void;
  readonly onOpenThread: (thread: CommandThread) => void;
  readonly onAnswerApproval: (request: ApprovalPendingRequest, decision: ApprovalDecision) => void;
  readonly onAnswerDecision: (request: DecisionPendingRequest, option: string) => void;
}

const NeedsYouContext = createContext<NeedsYouSource | undefined>(undefined);

export function NeedsYouProvider(props: {
  readonly source: NeedsYouSource | undefined;
  readonly children: ReactNode;
}) {
  return <NeedsYouContext.Provider value={props.source}>{props.children}</NeedsYouContext.Provider>;
}

export function useNeedsYou(): NeedsYouSource | undefined {
  return useContext(NeedsYouContext);
}
