import type { AppManagedToolSet } from "../providers/appManagedToolSet";

/**
 * Chat tools a thread is offered unless it is a Side Chat. A Side Chat is a
 * side conversation about another thread, not the lead of work the person is
 * steering, and it only reads: beyond the harness advice tools (which its
 * harness composition already narrows) it gains its read-only file tools over
 * the source and nothing else. So it is not offered side tasks, images,
 * Canvas, past threads, Computer, the `#thread` dialogue, or `octant_agents`,
 * the one tool that starts a child run. Before this was withheld those tools
 * reached every Side Chat only because it shares ordinary Chat's composition.
 */
export function withheldFromSideChat(input: {
  readonly sideChat: boolean;
  readonly tools: () => AppManagedToolSet | undefined;
}): AppManagedToolSet | undefined {
  return input.sideChat ? undefined : input.tools();
}
