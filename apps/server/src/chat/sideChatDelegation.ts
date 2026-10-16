import type { AppManagedToolSet } from "../providers/appManagedToolSet";

/**
 * The child-agent tools a thread is offered, or none for a Side Chat. A Side
 * Chat is a side conversation about another thread, not the lead of work the
 * person is steering, so it hands nothing to children: the harness `delegate`
 * tool is withheld by its composition, and this withholds `octant_agents`,
 * whose `delegate` operation starts a child run the same way.
 */
export function childAgentTools(input: {
  readonly sideChat: boolean;
  readonly tools: () => AppManagedToolSet;
}): AppManagedToolSet | undefined {
  return input.sideChat ? undefined : input.tools();
}
