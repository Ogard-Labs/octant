import type { CodeThread } from "@octant/contracts";
import { REQUEST_CREDENTIAL_TOOL } from "@octant/contracts/credential-request";
import { isToolAllowedByAllowlist } from "@octant/domain";
import type { CredentialOperation } from "@octant/plugin-api/credential-request";
import type { AppManagedToolSet } from "../providers/appManagedToolSet";
import type { CredentialRequests } from "./credentialRequests";

export function createCredentialRequestTools(options: {
  readonly service: CredentialRequests;
  readonly windowId: string;
  readonly thread: CodeThread;
  readonly readThread: () => CodeThread | undefined;
  readonly effective: () => boolean;
  readonly windowCurrent: () => boolean;
  readonly operation: CredentialOperation;
}): AppManagedToolSet {
  const lifetime = new AbortController();
  const current = () => {
    try {
      const thread = options.readThread();
      return (
        !lifetime.signal.aborted &&
        options.effective() &&
        options.windowCurrent() &&
        thread !== undefined &&
        thread.lifecycle === "active" &&
        thread.executionPolicy !== "plan" &&
        String(thread.projectId) === String(options.thread.projectId) &&
        String(thread.providerInstanceId) === String(options.thread.providerInstanceId) &&
        thread.modelId === options.thread.modelId &&
        String(thread.checkoutId) === String(options.thread.checkoutId) &&
        String(thread.bindingRevisionId) === String(options.thread.bindingRevisionId) &&
        isToolAllowedByAllowlist(thread.toolConstraints ?? [], REQUEST_CREDENTIAL_TOOL.name)
      );
    } catch {
      return false;
    }
  };
  return {
    definitions: current() ? [REQUEST_CREDENTIAL_TOOL] : [],
    close: async () => {
      lifetime.abort();
    },
    execute: async ({ name, inputJson, signal }) => {
      if (name !== REQUEST_CREDENTIAL_TOOL.name || !current())
        return { result: { status: "refused" }, isError: true };
      if (inputJson.length > 1024) return { result: { status: "invalid" }, isError: true };
      let input: unknown;
      try {
        input = JSON.parse(inputJson);
      } catch {
        return { result: { status: "invalid" }, isError: true };
      }
      if (
        typeof input !== "object" ||
        input === null ||
        Object.keys(input).length !== 1 ||
        !("operation" in input) ||
        input.operation !== options.operation.id
      ) {
        return { result: { status: "unsupported-operation" }, isError: true };
      }
      const result = await options.service.request({
        windowId: options.windowId,
        threadId: String(options.thread.id),
        current,
        operation: options.operation,
        signal: signal === undefined ? lifetime.signal : AbortSignal.any([signal, lifetime.signal]),
      });
      return { result, isError: result.status !== "used" };
    },
  };
}
