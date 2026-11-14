import type { SandboxPolicyLaunchDetails } from "@octant/contracts/sandbox-policy";
import type { SafeNetworkPlace } from "@octant/contracts";
import type { ToolEgressRule } from "@octant/domain/tool-egress-policy";
import { decodeSandboxNetworkDestination } from "@octant/contracts/sandbox-policy";
import { AsyncLocalStorage } from "node:async_hooks";
import type { SandboxPolicySelection, SandboxPolicyDenial } from "@octant/contracts/sandbox-policy";

export interface SandboxTurnRequest {
  readonly threadId: string;
  readonly projectId: string;
  readonly mode: "code" | "work";
  readonly root: string;
  readonly provider: string;
  readonly parentThreadId?: string;
}
export interface SandboxTurnPolicy {
  readonly selection?: SandboxPolicySelection;
  readonly summary: string;
  readonly current: () => boolean;
  readonly end: () => void | Promise<void>;
}
export type SandboxTurnAdmission =
  | { readonly status: "admitted"; readonly turn: SandboxTurnPolicy }
  | { readonly status: "refused"; readonly message: string };
export interface SandboxRestrictionsAuthority {
  readonly recordLaunch?: (
    selection: SandboxPolicySelection,
    details: SandboxPolicyLaunchDetails,
  ) => void;
  readonly validateSelection: (selection: SandboxPolicySelection) => boolean;
  readonly registerCleanup: (sessionId: string, cleanup: () => Promise<void>) => () => void;
  readonly storageDirectory: () => string | undefined;
  readonly beginTurn: (request: SandboxTurnRequest) => SandboxTurnAdmission;
  readonly active: (threadId: string) => SandboxPolicySelection | undefined;
  readonly deny: (input: Omit<SandboxPolicyDenial, "id" | "count" | "dismissed">) => void;
}
let authority: SandboxRestrictionsAuthority | undefined;
export function configureSandboxRestrictionsAuthority(
  value: SandboxRestrictionsAuthority | undefined,
): void {
  authority = value;
}
export function beginSandboxTurn(request: SandboxTurnRequest): SandboxTurnAdmission {
  const parent =
    request.parentThreadId === undefined ? undefined : authority?.active(request.parentThreadId);
  const result = authority?.beginTurn(request) ?? {
    status: "admitted" as const,
    turn: { summary: "", current: () => true, end: () => undefined },
  };
  if (result.status !== "admitted") return result;
  const selection = result.turn.selection;
  if (selection !== undefined && captureNetwork !== undefined) {
    const inherited = parent === undefined ? undefined : sandboxNetworkSnapshot(parent);
    networkSnapshots.set(
      selection.context.sessionId,
      inherited ?? captureNetwork(request.threadId, selection),
    );
    registerSandboxCleanup(selection, async () => {
      networkSnapshots.delete(selection.context.sessionId);
    });
  }
  if (parent === undefined) return result;
  const turn = result.turn;
  const remove = registerSandboxCleanup(parent, async () => {
    await turn.end();
  });
  return {
    ...result,
    turn: {
      ...turn,
      end: async () => {
        try {
          await turn.end();
        } finally {
          remove();
        }
      },
    },
  };
}
export function activeSandboxPolicy(threadId: string): SandboxPolicySelection | undefined {
  return authority?.active(threadId);
}
export function recordSandboxDenial(
  input: Omit<SandboxPolicyDenial, "id" | "count" | "dismissed">,
): void {
  authority?.deny(input);
}

export function sandboxPolicySummary(selection: SandboxPolicySelection): string {
  const policy = selection.policy;
  return `Full autonomy within your sandbox limits. Writes: Project${policy.filesystem.readWriteRoots.length ? ` + ${policy.filesystem.readWriteRoots.length} allowed folders` : ""}. Reads: Project${policy.filesystem.readOnlyRoots.length ? ` + ${policy.filesystem.readOnlyRoots.length} read-only folders` : ""}. Network: ${policy.network === "deny" ? "blocked (provider connection separate)" : policy.network === "unrestricted" ? "unrestricted" : "existing Safe networks settings"}. Host services: ${policy.hostServices === "blocked" ? "blocked" : "existing sandbox rules"}.`;
}

export function sandboxAuthorityDirectory(): string | undefined {
  return authority?.storageDirectory();
}

const toolPolicy = new AsyncLocalStorage<{
  readonly selection: SandboxPolicySelection;
  readonly threadId: string;
  active: boolean;
  readonly network?: SandboxToolNetwork;
}>();
export async function withSandboxToolPolicy<T>(
  threadId: string,
  run: () => Promise<T>,
): Promise<T> {
  const existing = toolPolicy.getStore();
  if (
    existing !== undefined &&
    (!existing.active || activeSandboxPolicy(existing.threadId) !== existing.selection)
  )
    throw new Error("This sandbox tool call has expired.");
  const selection = activeSandboxPolicy(threadId);
  if (selection === undefined) return run();
  if (existing?.selection === selection && existing.active) return run();
  let settle = () => {};
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const unregister = registerSandboxCleanup(selection, () => settled);
  let network: SandboxToolNetwork | undefined;
  try {
    network =
      (selection.policy.approvedDestinations?.length ?? 0) > 0 ||
      (selection.policy.network === "existing-policy" &&
        ((sandboxNetworkSnapshot(selection)?.limitsOn ?? networkLimitsOn()) ||
          selection.policy.hostServices === "blocked")) ||
      (selection.policy.network === "unrestricted" && selection.policy.hostServices === "blocked")
        ? await startNetwork?.(threadId, selection)
        : undefined;
  } catch (error) {
    settle();
    unregister();
    throw error;
  }
  const context = {
    selection,
    threadId,
    active: true,
    ...(network === undefined ? {} : { network }),
  };
  return toolPolicy.run(context, async () => {
    try {
      return await run();
    } finally {
      context.active = false;
      try {
        await network?.close();
      } finally {
        settle();
        unregister();
      }
    }
  });
}
export function sandboxToolPolicy(): SandboxPolicySelection | undefined {
  const context = toolPolicy.getStore();
  if (context === undefined) return undefined;
  if (!context.active || activeSandboxPolicy(context.threadId) !== context.selection)
    throw new Error(
      "This sandbox tool call expired before execution. Retry from the current turn.",
    );
  return context.selection;
}

export interface SandboxToolNetwork {
  readonly permitsHostRequest: (host: string, port: number) => boolean;
  readonly networkEgress: import("./threadEgressPolicy").OsNetworkEgress;
  readonly environment: Readonly<Record<string, string>>;
  readonly close: () => Promise<void>;
}
let startNetwork:
  | ((threadId: string, policy: SandboxPolicySelection) => Promise<SandboxToolNetwork>)
  | undefined;
let networkLimitsOn: () => boolean = () => true;
export function configureSandboxToolNetwork(
  start: typeof startNetwork,
  limits: () => boolean,
): void {
  startNetwork = start;
  networkLimitsOn = limits;
}
export function sandboxNetworkLimitsOn(): boolean {
  return sandboxNetworkSnapshot(toolPolicy.getStore()?.selection)?.limitsOn ?? networkLimitsOn();
}
export function sandboxToolNetwork(
  expected?: SandboxPolicySelection,
): SandboxToolNetwork | undefined {
  const context = toolPolicy.getStore();
  if (
    context === undefined ||
    !context.active ||
    (expected !== undefined && context.selection !== expected)
  )
    return undefined;
  return activeSandboxPolicy(context.threadId) === context.selection ? context.network : undefined;
}

/** A separately admitted helper owns its tool lifetimes, not the launching call's async context. */
export function outsideSandboxToolCall<T>(run: () => T): T {
  return toolPolicy.exit(run);
}

export function registerSandboxCleanup(
  selection: SandboxPolicySelection | undefined,
  cleanup: () => Promise<void>,
): () => void {
  return selection === undefined
    ? () => undefined
    : (authority?.registerCleanup(selection.context.sessionId, cleanup) ?? (() => undefined));
}
export function trackSandboxChild(
  selection: SandboxPolicySelection | undefined,
  child: import("node:child_process").ChildProcess,
): void {
  if (selection === undefined) return;
  let remove: () => void;
  try {
    remove = registerSandboxCleanup(selection, async () => {
      if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        child.once("error", () => resolve());
      });
      // A Linux policy launch is a PID namespace: terminating its owned leader
      // also terminates detached descendants. Other backends need their own
      // proven tree-revocation capability before enrolling a selected policy.
      child.kill("SIGKILL");
      await exited;
    });
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }
  child.once("exit", remove);
  child.once("error", remove);
}

export function authorizeSandboxHostRequest(url: URL): void {
  const selection = sandboxToolPolicy();
  if (selection === undefined) return;
  const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
  const permitted =
    (selection.policy.network === "unrestricted" && selection.policy.hostServices !== "blocked") ||
    (selection.policy.network === "existing-policy" && !sandboxNetworkLimitsOn()) ||
    sandboxToolNetwork()?.permitsHostRequest(url.hostname, port) === true;
  if (
    (selection.policy.network !== "deny" ||
      (selection.policy.approvedDestinations?.length ?? 0) > 0) &&
    permitted
  )
    return;
  const threadId = toolPolicy.getStore()?.threadId;
  if (threadId !== undefined) recordSandboxNetworkDenial(threadId, url.hostname, port);
  throw new Error(
    `Sandbox network policy refused ${url.hostname}:${port}. Review Safe networks before retrying.`,
  );
}

export function recordSandboxNetworkDenial(threadId: string, host: string, port: number): void {
  const selection = activeSandboxPolicy(threadId);
  if (selection === undefined) return;
  let destination: import("@octant/contracts/sandbox-policy").SandboxNetworkDestination | undefined;
  try {
    destination = decodeSandboxNetworkDestination({ host, port });
  } catch {
    /* Invalid or local-service destinations cannot become a network exception. */
  }
  recordSandboxDenial({
    threadId,
    projectId: selection.context.projectId,
    code: "sandbox-network-denied",
    ruleId: "network.destinations",
    operation: "network",
    resource: `${host}:${port}`,
    ...(destination === undefined ? {} : { destination }),
    message: `Network access to ${host}:${port} is blocked by this sandbox.`,
    remedy: "Review the exact destination and port before allowing it for this session or Project.",
    grantable: destination !== undefined,
  });
}

export interface SandboxNetworkSnapshot {
  readonly places: ReadonlyArray<SafeNetworkPlace>;
  readonly rules: ReadonlyArray<ToolEgressRule>;
  readonly limitsOn: boolean;
}
const networkSnapshots = new Map<string, SandboxNetworkSnapshot>();
let captureNetwork:
  | ((threadId: string, selection: SandboxPolicySelection) => SandboxNetworkSnapshot)
  | undefined;
export function configureSandboxNetworkSnapshot(capture: typeof captureNetwork): void {
  captureNetwork = capture;
}
export function sandboxNetworkSnapshot(
  selection: SandboxPolicySelection | undefined,
): SandboxNetworkSnapshot | undefined {
  return selection === undefined ? undefined : networkSnapshots.get(selection.context.sessionId);
}

export function sandboxSelectionIsCurrent(selection: SandboxPolicySelection): boolean {
  return authority?.validateSelection(selection) ?? true;
}

export function recordSandboxLaunch(
  selection: SandboxPolicySelection,
  details: SandboxPolicyLaunchDetails,
): void {
  authority?.recordLaunch?.(selection, details);
}
