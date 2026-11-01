import type { ShieldForgeHardLine } from "@octant/contracts";
import {
  type ForgeShellChange,
  forgeShellChanges,
  forgeShellHardLine,
} from "@octant/domain/forge-shell-change-policy";

/**
 * The pushes and pull-request changes a provider runtime's own shell makes,
 * as Octant sees them: the runtime reports a command only as it starts, so
 * nothing here can stop one. Each is journaled under the thread, and at Full
 * access, where no one was asked, one that crosses a hard line is flagged
 * with it. Canonical: docs/architecture.md § Modes (Git and pull requests).
 */
export interface RuntimeForgeChangeObserver {
  readonly observe: (input: {
    readonly threadId: string;
    /** The first line of the command, redacted, as the runtime's tool start named it. */
    readonly command: string;
    readonly fullAccess: boolean;
  }) => void;
}

export function createRuntimeForgeChangeObserver(input: {
  readonly branches: (threadId: string) => {
    readonly ownBranch?: string | undefined;
    readonly otherThreadBranches: ReadonlyArray<string>;
  };
  readonly record: (input: {
    readonly threadId: string;
    readonly via: "provider-runtime";
    readonly changes: ReadonlyArray<ForgeShellChange>;
    readonly outcome: "seen-after-start";
    readonly hardLine?: ShieldForgeHardLine | undefined;
    readonly command: string;
  }) => unknown;
}): RuntimeForgeChangeObserver {
  return {
    observe: ({ threadId, command, fullAccess }) => {
      try {
        const changes = forgeShellChanges(command);
        if (changes.length === 0) return;
        // Below Full access the runtime asked first, and Shield or the person
        // answered, so the act was not one nobody asked for.
        const hardLine = fullAccess
          ? forgeShellHardLine(changes, input.branches(threadId))
          : undefined;
        input.record({
          threadId,
          via: "provider-runtime",
          changes,
          outcome: "seen-after-start",
          ...(hardLine === undefined ? {} : { hardLine }),
          command,
        });
      } catch {
        // A record that cannot be kept leaves the turn as it was: the command
        // already started, and the transcript still shows it.
      }
    },
  };
}
