import type { CodeThread } from "@octant/contracts";
import { OCTANT_CREDENTIAL_TOOL } from "@octant/contracts/credential-request";
import { isToolAllowedByAllowlist } from "@octant/domain";
import type { CredentialOperation } from "@octant/plugin-api/credential-request";
import type { CredentialToolSource } from "./credentialTool";
import type { CredentialRequests } from "./credentialRequests";

/** What `list` shows of a registered operation: never its destination request. */
export interface RegisteredCredentialOperationEntry {
  readonly id: string;
  readonly label: string;
  readonly reason: string;
}

/**
 * The `request` side of the credential tool: a one-use card for an operation
 * an admitted integration registered. It is usable only from the turn's own
 * local window, on an active thread outside Plan whose binding has not moved.
 */
export function registeredCredentialOperations(options: {
  readonly service: CredentialRequests;
  readonly windowId: string;
  readonly thread: CodeThread;
  readonly readThread: () => CodeThread | undefined;
  readonly operations: () => ReadonlyArray<CredentialOperation>;
  readonly windowCurrent: () => boolean;
}): CredentialToolSource<RegisteredCredentialOperationEntry> {
  const lifetime = new AbortController();
  const current = () => {
    try {
      const thread = options.readThread();
      return (
        !lifetime.signal.aborted &&
        options.windowCurrent() &&
        thread !== undefined &&
        thread.lifecycle === "active" &&
        thread.executionPolicy !== "plan" &&
        String(thread.projectId) === String(options.thread.projectId) &&
        String(thread.providerInstanceId) === String(options.thread.providerInstanceId) &&
        thread.modelId === options.thread.modelId &&
        String(thread.checkoutId) === String(options.thread.checkoutId) &&
        String(thread.bindingRevisionId) === String(options.thread.bindingRevisionId) &&
        isToolAllowedByAllowlist(thread.toolConstraints ?? [], OCTANT_CREDENTIAL_TOOL.name)
      );
    } catch {
      return false;
    }
  };
  return {
    offered: current() && options.operations().length > 0,
    list: () =>
      current()
        ? options.operations().map(({ id, label, reason }) => ({ id, label, reason }))
        : undefined,
    close: async () => {
      lifetime.abort();
    },
    use: async (id, signal) => {
      if (!current()) return { result: { status: "refused" }, isError: true };
      const operation = options.operations().find((candidate) => candidate.id === id);
      if (operation === undefined)
        return { result: { status: "unsupported-operation" }, isError: true };
      const result = await options.service.request({
        windowId: options.windowId,
        threadId: String(options.thread.id),
        current: () => current() && options.operations().includes(operation),
        operation,
        signal: signal === undefined ? lifetime.signal : AbortSignal.any([signal, lifetime.signal]),
      });
      return { result, isError: result.status !== "used" };
    },
  };
}
