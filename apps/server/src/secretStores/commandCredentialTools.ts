import { randomUUID } from "node:crypto";
import type { CredentialToolSource } from "../credentials/credentialTool";
import type { CommandCredentialBindings } from "./commandCredentialBindings";

/** What `list` shows of a saved command: never its account or vault references. */
export interface SavedCredentialCommandEntry {
  readonly id: string;
  readonly label: string;
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly directory: string;
}

/**
 * The `run-saved` side of the credential tool. A provider selects a saved
 * binding by id; only the person can approve its process, through the same
 * review the Code conversation offers them.
 */
export function savedCredentialCommands(options: {
  readonly service: CommandCredentialBindings;
  readonly windowId: string;
  readonly threadId: string;
  readonly projectId: string;
  readonly current: () => boolean;
}): CredentialToolSource<SavedCredentialCommandEntry> {
  const lifetime = new AbortController();
  const requests = new Set<string>();
  const current = () => !lifetime.signal.aborted && options.current();
  const bindings = () => {
    const view = options.service.view(options.windowId, options.projectId);
    return view.kind === "command-credential-view" ? view.bindings : [];
  };
  return {
    // Bindings live in host memory, so whether this Project has one is known
    // when the turn's tools are composed. One saved during the turn is offered
    // from the next turn.
    offered: current() && bindings().length > 0,
    list: () =>
      current()
        ? bindings().map(({ bindingId, definition }) => ({
            id: bindingId,
            label: definition.label,
            executable: definition.executable,
            args: definition.args,
            directory: definition.directory,
          }))
        : undefined,
    close: async () => {
      lifetime.abort();
      for (const id of requests) options.service.cancel(options.windowId, id);
    },
    use: async (bindingId, signal) => {
      if (!current()) return { result: { status: "refused" }, isError: true };
      if (bindingId === undefined) return { result: { status: "invalid" }, isError: true };
      const review = await options.service.review(
        options.windowId,
        options.threadId,
        bindingId,
        randomUUID(),
      );
      if (review.kind !== "command-credential-view") return { result: review, isError: true };
      const request = review.requests.find(
        (entry) =>
          String(entry.threadId) === options.threadId &&
          String(entry.binding.bindingId) === bindingId,
      );
      if (request === undefined) return { result: { status: "refused" }, isError: true };
      requests.add(request.requestId);
      const combined =
        signal === undefined ? lifetime.signal : AbortSignal.any([signal, lifetime.signal]);
      const cancel = () => {
        options.service.cancel(options.windowId, request.requestId);
      };
      combined.addEventListener("abort", cancel, { once: true });
      try {
        if (combined.aborted || !current()) cancel();
        const result = await options.service.wait(options.windowId, request.requestId);
        return {
          result,
          isError:
            result.kind !== "command-credential-receipt" ||
            result.status !== "exited" ||
            result.exitCode !== 0,
        };
      } finally {
        combined.removeEventListener("abort", cancel);
        requests.delete(request.requestId);
      }
    },
  };
}
