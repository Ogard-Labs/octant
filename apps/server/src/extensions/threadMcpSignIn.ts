import type {
  ExtensionEffectiveSnapshot,
  ExtensionEffectiveStateQuery,
  ExtensionSnapshot,
  McpServerConnectionListing,
  McpServerConnectionRequest,
} from "@octant/contracts/extension-rpc";
import {
  decodeChatThreadId,
  decodeCodeThreadId,
  decodeWorkThreadId,
  type ChatThread,
  type CodeThread,
  type WorkThread,
} from "@octant/contracts";
import { ExtensionProviderFamily } from "@octant/contracts/extensions";
import { LOCAL_HOST_ID } from "@octant/contracts/host";
import type { OctantMode } from "@octant/contracts/modes";
import type { ProjectId } from "@octant/contracts/projects";
import { resolveDraftExtensionReference, revalidateExtensionSelection } from "@octant/plugin-host";
import { Schema } from "effect";
import { buildCatalogs, type ExtensionSelectionSubject } from "./extensionChatResolver";
import { draftAddressing, pinnedSelections, rebindDraftSelections } from "./selectedExtensions";

const decodeProviderFamily = Schema.decodeUnknownSync(ExtensionProviderFamily);

export type ThreadMcpSignInRequest = Extract<
  McpServerConnectionRequest,
  { readonly kind: "thread-sign-in" }
>;

/** What the host's own records say about the thread's next turn. */
export interface ThreadMcpSignInThread {
  readonly projectId: ProjectId | null;
  readonly version: number;
  readonly providerInstanceId: ExtensionSelectionSubject["providerInstanceId"];
  readonly modelId: ExtensionSelectionSubject["modelId"];
  readonly providerFamily: ExtensionProviderFamily;
  readonly pinnedExtensionIds: ReadonlyArray<string>;
}

/** Reads what a thread's next turn would run as, from the host's records. */
export function createThreadMcpSignInThreads(records: {
  readonly readChatThread: (threadId: ChatThread["id"]) => ChatThread | undefined;
  readonly readWorkThread: (threadId: WorkThread["id"]) => WorkThread | undefined;
  readonly readCodeThread: (threadId: CodeThread["id"]) => CodeThread | undefined;
  readonly driverKind: (
    providerInstanceId: ExtensionSelectionSubject["providerInstanceId"],
  ) => string | undefined;
  readonly onServer: (projectId: string) => boolean;
  readonly strict: (threadId: string) => boolean;
  /** Undefined until the provider has been observed. */
  readonly carriesAppManagedTools: (thread: WorkThread | CodeThread) => boolean | undefined;
  readonly pinnedExtensionIds: (projectId: string) => ReadonlyArray<string>;
  readonly platform: string;
}): (mode: OctantMode, threadId: string) => ThreadMcpSignInThread | undefined {
  return (mode, threadId) => {
    // Windows Strict runs no Octant-operated tool, in any mode.
    if (records.platform === "win32" && records.strict(threadId)) return undefined;
    const runsAs = (
      thread: ChatThread | WorkThread | CodeThread,
      pinnedExtensionIds: ReadonlyArray<string>,
    ): ThreadMcpSignInThread | undefined => {
      const driverKind = records.driverKind(thread.providerInstanceId);
      if (driverKind === undefined) return undefined;
      return {
        projectId: thread.projectId ?? null,
        version: Number(thread.version),
        providerInstanceId: thread.providerInstanceId,
        modelId: thread.modelId,
        providerFamily: decodeProviderFamily(driverKind),
        pinnedExtensionIds,
      };
    };
    if (mode === "chat") {
      const thread = records.readChatThread(decodeChatThreadId(threadId));
      // Chat has no Project pins; each turn names its own servers.
      return thread === undefined ? undefined : runsAs(thread, []);
    }
    const thread =
      mode === "work"
        ? records.readWorkThread(decodeWorkThreadId(threadId))
        : records.readCodeThread(decodeCodeThreadId(threadId));
    // Where a Work or Code turn leaves extension tools out. A provider not
    // observed yet is not known to lack them, so it does not hide a sign-in.
    if (
      thread === undefined ||
      records.onServer(String(thread.projectId)) ||
      records.carriesAppManagedTools(thread) === false
    )
      return undefined;
    return runsAs(thread, records.pinnedExtensionIds(String(thread.projectId)));
  };
}

/**
 * Which servers the thread's next turn would get but cannot use until someone
 * signs in. A server counts only through the checks that turn makes: the
 * Project's pins and the selections the turn would carry, against the thread's
 * own activation. It connects nothing: the turn also drops a server whose
 * connection failed, and a missing sign-in is what makes it fail, so asking
 * the sessions would hide every server this read exists to name.
 */
export function createThreadMcpSignInReader(options: {
  readonly snapshot: () => ExtensionSnapshot;
  readonly resolveEffectiveState: (
    snapshot: ExtensionSnapshot,
    query: ExtensionEffectiveStateQuery,
  ) => ExtensionEffectiveSnapshot;
  /** Undefined when there is no such thread, or its turns carry no extension tools. */
  readonly thread: (mode: OctantMode, threadId: string) => ThreadMcpSignInThread | undefined;
  /** The listing of these servers, each named `extensionId/componentId`. */
  readonly connections: (servers: ReadonlySet<string>) => Promise<McpServerConnectionListing>;
}): (request: ThreadMcpSignInRequest) => Promise<McpServerConnectionListing> {
  return async ({ mode, threadId, selections, references }) => {
    const none: McpServerConnectionListing = { servers: [] };
    const thread = options.thread(mode, threadId);
    if (thread === undefined) return none;
    const snapshot = options.snapshot();
    const effective = options.resolveEffectiveState(snapshot, {
      scope: {
        hostId: LOCAL_HOST_ID,
        mode,
        projectId: thread.projectId,
        threadId,
        providerFamily: thread.providerFamily,
      },
    });
    const { addressing } = buildCatalogs(snapshot, effective, {
      mode,
      threadId,
      projectId: thread.projectId === null ? null : String(thread.projectId),
      threadVersion: thread.version,
      providerInstanceId: thread.providerInstanceId,
      modelId: thread.modelId,
    });
    // Work and Code rebind a selection the new-task draft made, as their turn
    // does; Chat takes none over to a thread.
    const rebound =
      mode === "chat"
        ? selections
        : rebindDraftSelections(selections, addressing.epoch, () =>
            draftAddressing(options.resolveEffectiveState, snapshot, effective, thread, mode),
          ).flatMap((result) => (result.kind === "selected" ? [result.selection] : []));
    const carried = rebound.filter(
      (selection) =>
        revalidateExtensionSelection(selection, addressing, "provider-handoff").kind === "selected",
    );
    // The composer refuses a server whose connection failed, so its draft holds
    // the name alone; the name is resolved here as the composer resolves one.
    const namedBy = new Map<string, string[]>();
    const named = references.flatMap((reference) => {
      const resolved = resolveDraftExtensionReference(reference, addressing, "draft");
      if (resolved.kind !== "selected") return [];
      if (resolved.selection.kind === "plugin") {
        const key = `${resolved.selection.extensionId}/${resolved.selection.componentId}`;
        namedBy.set(key, [...(namedBy.get(key) ?? []), reference]);
      }
      return [resolved.selection];
    });
    const used = new Set(
      [
        ...carried,
        ...named,
        ...pinnedSelections(
          thread.pinnedExtensionIds,
          carried,
          addressing,
          String(thread.projectId),
        ),
      ].flatMap((selection) =>
        selection.kind === "plugin" ? [`${selection.extensionId}/${selection.componentId}`] : [],
      ),
    );
    if (used.size === 0) return none;
    const { servers } = await options.connections(used);
    return {
      servers: servers.flatMap((server) => {
        const key = `${server.extensionId}/${server.componentId}`;
        if (server.state !== "needs-sign-in" || !used.has(key)) return [];
        // The composer resolves these names again once this server no longer
        // waits on a sign-in, and leaves the names of other servers alone.
        const references = namedBy.get(key);
        return [references === undefined ? server : { ...server, references }];
      }),
    };
  };
}
