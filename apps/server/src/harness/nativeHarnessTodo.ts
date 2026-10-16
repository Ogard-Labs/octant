import type { NativeHarnessTodoItem } from "@octant/contracts";
import type { NativeHarnessSessionStore } from "./nativeHarnessSessionStore";
import type { NativeHarnessToolPorts } from "./nativeHarnessTools";

/**
 * `todo-write` over the thread's harness session. The task list is the lead's
 * own working notes, journaled on the session so every surface can show its
 * progress. It is not a thread plan: a plan is the person's to approve, and a
 * list that waited for approval could never record that a step is under way.
 */
export function createNativeHarnessTodoPort(input: {
  readonly sessions: Pick<NativeHarnessSessionStore, "replaceTasks">;
  readonly threadId: string;
}): NonNullable<NativeHarnessToolPorts["todo"]> {
  return {
    replace: async (items: ReadonlyArray<NativeHarnessTodoItem>) => {
      if (input.sessions.replaceTasks(input.threadId, items) === "no-session") {
        throw new Error("This thread has no harness session to keep a task list on.");
      }
    },
  };
}
