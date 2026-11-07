import type { CodeThread } from "@octant/contracts";
import { OCTANT_CREDENTIAL_TOOL } from "@octant/contracts/credential-request";
import { isToolAllowedByAllowlist } from "@octant/domain";
import { clampTurnAccessPosture } from "@octant/domain/code-policy";
import type { CodeToolHostPort, CodeToolContribution } from "@octant/plugin-api/code-tools";
import type { CredentialOperation } from "@octant/plugin-api/credential-request";
import type { CommandCredentialBindings } from "../secretStores/commandCredentialBindings";
import { savedCredentialCommands } from "../secretStores/commandCredentialTools";
import { registeredCredentialOperations } from "./credentialRequestTools";
import type { CredentialRequests } from "./credentialRequests";

const identity = (thread: CodeThread) =>
  JSON.stringify([
    thread.id,
    thread.projectId,
    thread.checkoutId,
    thread.bindingRevisionId,
    thread.providerInstanceId,
    thread.modelId,
    thread.modelOptionValues,
    thread.profileId,
    thread.toolConstraints,
    thread.executionPolicy,
    thread.lifecycle,
  ]);

/** Only this host adapter sees services or saved definitions; the public port cannot read them. */
export function createCodeToolHostPort(options: {
  readonly windowId: string;
  readonly thread: CodeThread;
  readonly readThread: () => CodeThread | undefined;
  readonly current: () => boolean;
  readonly contribution: CodeToolContribution;
  readonly toolName: string;
  readonly credentialRequests: CredentialRequests;
  readonly commands: CommandCredentialBindings;
  readonly operations: () => ReadonlyArray<CredentialOperation>;
}): CodeToolHostPort {
  let closed = false;
  const key = identity(options.thread);
  const readThread = () => {
    const thread = options.readThread();
    if (thread === undefined) return undefined;
    // Selection composes before the runtime owns the turn. Preserve that
    // admitted turn's narrower ceiling, and still clamp any later lower grant.
    return {
      ...thread,
      executionPolicy: clampTurnAccessPosture({
        thread: thread.executionPolicy,
        requested: options.thread.executionPolicy,
      }),
    };
  };
  const current = () => {
    try {
      const thread = readThread();
      return (
        !closed &&
        options.current() &&
        thread !== undefined &&
        thread.lifecycle === "active" &&
        thread.executionPolicy !== "plan" &&
        identity(thread) === key &&
        isToolAllowedByAllowlist(thread.toolConstraints ?? [], options.toolName) &&
        isToolAllowedByAllowlist(thread.toolConstraints ?? [], OCTANT_CREDENTIAL_TOOL.name)
      );
    } catch {
      return false;
    }
  };
  const registered = registeredCredentialOperations({
    service: options.credentialRequests,
    windowId: options.windowId,
    thread: options.thread,
    readThread,
    operations: () =>
      options
        .operations()
        .filter((operation) => options.contribution.operationIds.includes(operation.id)),
    windowCurrent: current,
  });
  const saved = savedCredentialCommands({
    service: options.commands,
    windowId: options.windowId,
    threadId: String(options.thread.id),
    projectId: String(options.thread.projectId),
    current,
  });
  const operationEntries = () => (current() && registered.offered ? registered.list() : undefined);
  const savedEntries = () =>
    current() && saved.offered
      ? saved.list()?.filter((entry) => options.contribution.savedCommandIds.includes(entry.id))
      : undefined;
  return {
    operations: () => operationEntries()?.map(({ id, label, reason }) => ({ id, label, reason })),
    savedCommands: () => savedEntries()?.map(({ id, label }) => ({ id, label })),
    request: async (id, signal) =>
      operationEntries()?.some((entry) => entry.id === id)
        ? registered.use(id, signal)
        : { result: { status: "refused" }, isError: true },
    runSaved: async (id, signal) =>
      savedEntries()?.some((entry) => entry.id === id)
        ? saved.use(id, signal)
        : { result: { status: "refused" }, isError: true },
    close: async () => {
      closed = true;
      await Promise.all([registered.close(), saved.close()]);
    },
  };
}
