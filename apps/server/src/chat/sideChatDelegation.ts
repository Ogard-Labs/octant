import type { AppManagedToolSet } from "../providers/appManagedToolSet";

/**
 * The child-run tool a Chat thread is offered, or none for a Side Chat. A
 * Side Chat is a side conversation about another thread, not the lead of work
 * the person is steering, so it hands nothing to children: this withholds
 * `octant_agents`, the one tool that starts a child run, whichever runtime
 * the thread uses.
 */
export function childAgentTools(input: {
  readonly sideChat: boolean;
  readonly tools: () => AppManagedToolSet;
}): AppManagedToolSet | undefined {
  return input.sideChat ? undefined : input.tools();
}
