import { randomUUID } from "node:crypto";
import type { AppManagedToolSet } from "../providers/appManagedToolSet";
import type { CommandCredentialBindings } from "./commandCredentialBindings";

/** A provider selects a saved binding; only the person can approve its process. */
export function commandCredentialTools(options: {
  readonly service: CommandCredentialBindings;
  readonly windowId: string;
  readonly threadId: string;
  readonly projectId: string;
  readonly current: () => boolean;
}): AppManagedToolSet {
  const lifetime = new AbortController();
  const requests = new Set<string>();
  const current = () => !lifetime.signal.aborted && options.current();
  return {
    definitions: current()
      ? [
          {
            name: "octant_command",
            description:
              "List saved credential commands for this Code Project or request one named command. A person must review and approve each run. Full access only. No secret values are returned by the credential store; the recipient has ordinary Full access and masking cannot prevent deliberate disclosure.",
            inputSchema: {
              type: "object",
              properties: {
                operation: { type: "string", enum: ["list", "run"] },
                bindingId: { type: "string" },
              },
              required: ["operation"],
              additionalProperties: false,
            },
          },
        ]
      : [],
    close: async () => {
      lifetime.abort();
      for (const id of requests) options.service.cancel(options.windowId, id);
    },
    execute: async ({ name, inputJson, signal }) => {
      if (name !== "octant_command" || !current() || inputJson.length > 1024)
        return { result: { status: "refused" }, isError: true };
      let input: unknown;
      try {
        input = JSON.parse(inputJson);
      } catch {
        return { result: { status: "invalid" }, isError: true };
      }
      if (
        typeof input !== "object" ||
        input === null ||
        !("operation" in input) ||
        Object.keys(input).some((key) => key !== "operation" && key !== "bindingId")
      )
        return { result: { status: "invalid" }, isError: true };
      if (input.operation === "list" && !("bindingId" in input)) {
        const view = options.service.view(options.windowId, options.projectId);
        return {
          result: view.kind === "command-credential-view" ? { bindings: view.bindings } : view,
          isError: view.kind !== "command-credential-view",
        };
      }
      if (
        input.operation !== "run" ||
        !("bindingId" in input) ||
        typeof input.bindingId !== "string"
      )
        return { result: { status: "invalid" }, isError: true };
      const review = await options.service.review(
        options.windowId,
        options.threadId,
        input.bindingId,
        randomUUID(),
      );
      if (review.kind !== "command-credential-view") return { result: review, isError: true };
      const request = review.requests.find(
        (entry) =>
          String(entry.threadId) === options.threadId &&
          String(entry.binding.bindingId) === input.bindingId,
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
