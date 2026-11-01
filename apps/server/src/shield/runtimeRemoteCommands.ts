import type { ProviderRuntimeEvent } from "@octant/contracts";
import { remoteHostsNamedBy } from "@octant/domain/shield-server-policy";
import type { ShieldServerStore } from "./shieldServerStore";

/** Started remote commands held per thread at most; an older one is let go unrecorded. */
const MAX_STARTED = 256;

/**
 * Octant Shield's record of the `ssh`, `scp`, and `rsync` commands a provider
 * runtime runs with its own shell tool. The runtime names the command when
 * the tool starts (Codex every command, Claude Code a remote one); when it
 * ends, the command is journaled under the thread as a harness command is,
 * with its exit status where the runtime reports one (Codex). A runtime that
 * names no command leaves Shield's journaled approval decision as the record.
 */
export class RuntimeRemoteCommands {
  readonly #record: ShieldServerStore["recordRemoteCommand"];
  readonly #started = new Map<string, string>();

  constructor(record: ShieldServerStore["recordRemoteCommand"]) {
    this.#record = record;
  }

  observe(threadId: string, projectId: string | undefined, event: ProviderRuntimeEvent): void {
    if (event.kind === "tool-start") {
      if (event.argument === undefined || remoteHostsNamedBy(event.argument).length === 0) return;
      if (this.#started.size >= MAX_STARTED) {
        const oldest = this.#started.keys().next().value;
        if (oldest !== undefined) this.#started.delete(oldest);
      }
      this.#started.set(`${threadId}\u0000${event.toolCallId}`, event.argument);
      return;
    }
    if (event.kind !== "tool-success" && event.kind !== "tool-failure") return;
    const key = `${threadId}\u0000${event.toolCallId}`;
    const command = this.#started.get(key);
    if (command === undefined) return;
    this.#started.delete(key);
    // A failure with no exit status may not have run at all, so how it ended
    // is recorded as unknown rather than as a run.
    const status =
      event.kind === "tool-success" || event.exitCode !== undefined ? "ran" : "unavailable";
    this.#record({
      threadId,
      projectId,
      command,
      status,
      ...(event.exitCode === undefined ? {} : { exitCode: event.exitCode }),
    });
  }
}
