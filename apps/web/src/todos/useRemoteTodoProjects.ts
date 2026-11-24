import type { HostFederationTransports } from "@octant/client-runtime/host-federation-transports";
import type { RemoteSessionBridge } from "@octant/client-runtime";
import type { CodeNavigation } from "@octant/contracts/code";
import type { ProjectSummary } from "@octant/contracts/projects";
import { useCallback, useState } from "react";
import { createRemoteProductClients } from "../remote/remoteProductClients";
import type { ChatThreadNavigationItem } from "../shell/navigationModel";
import { buildChatThreadNavigation } from "../shell/navigationModel";
import { useVisibleRefresh } from "../polling/useVisibleRefresh";
import { buildWorkThreadNavigation } from "../work/useWorkThreadNavigation";

export interface RemoteTodoProject {
  readonly hostId: string;
  readonly hostName: string;
  readonly bridge: RemoteSessionBridge;
  readonly project: ProjectSummary;
}

interface RemoteTodoThreadRows {
  readonly hostId: string;
  readonly bridge: RemoteSessionBridge;
  readonly chat: ReadonlyArray<ChatThreadNavigationItem>;
  readonly code: ReadonlyArray<ChatThreadNavigationItem>;
  readonly work: ReadonlyArray<ChatThreadNavigationItem>;
}

interface RemoteTodoProjects {
  readonly projects: ReadonlyArray<RemoteTodoProject>;
  readonly threadRows: ReadonlyArray<RemoteTodoThreadRows>;
}

function codeTodoThreadRows(navigation: CodeNavigation): ReadonlyArray<ChatThreadNavigationItem> {
  const runtimeByThread = new Map(
    navigation.runtime.map((entry) => [String(entry.threadId), entry] as const),
  );
  return navigation.threads
    .filter((thread) => thread.lifecycle !== "archived")
    .map((thread) => {
      const runtime = runtimeByThread.get(String(thread.id));
      // The whole list from a host that sends it, else the board's three.
      const pullRequests = runtime?.threadPullRequests ?? runtime?.pullRequestSummaries;
      return {
        threadId: String(thread.id),
        title: thread.title,
        ...(runtime?.awaitingInput === true
          ? { activity: "attention" as const }
          : runtime?.executing === true
            ? { activity: "working" as const }
            : {}),
        ...(thread.completedAt === undefined ? {} : { completedAt: thread.completedAt }),
        ...(thread.markedDoneAt === undefined ? {} : { markedDone: true as const }),
        ...(pullRequests === undefined ? {} : { pullRequests }),
      };
    });
}

export function useRemoteTodoProjects(
  transports: HostFederationTransports | undefined,
  revision: number,
): RemoteTodoProjects {
  const [projects, setProjects] = useState<ReadonlyArray<RemoteTodoProject>>([]);
  const [threadRows, setThreadRows] = useState<ReadonlyArray<RemoteTodoThreadRows>>([]);
  const refresh = useCallback(
    async (signal: AbortSignal) => {
      const ready = (transports?.list() ?? []).flatMap((slot) =>
        slot.kind === "remote" && slot.bridge !== undefined && slot.state.kind === "ready"
          ? [{ hostId: String(slot.hostId), hostName: slot.displayName, bridge: slot.bridge }]
          : [],
      );
      const readyBridges = new Map(ready.map((slot) => [slot.hostId, slot.bridge] as const));
      setProjects((current) =>
        current.filter((entry) => readyBridges.get(entry.hostId) === entry.bridge),
      );
      setThreadRows((current) =>
        current.filter((entry) => readyBridges.get(entry.hostId) === entry.bridge),
      );
      const [projectResults, navigationResults] = await Promise.all([
        Promise.allSettled(
          ready.map(async (slot) => {
            const clients = createRemoteProductClients(slot.bridge);
            const view = await clients.project.bootstrap();
            return view.active
              .filter((project) => project.lifecycle === "active")
              .map((project) => ({
                hostId: slot.hostId,
                hostName: slot.hostName,
                bridge: slot.bridge,
                project,
              }));
          }),
        ),
        Promise.allSettled(
          ready.map(async (slot) => {
            const clients = createRemoteProductClients(slot.bridge);
            const [chat, code, work] = await Promise.allSettled([
              Promise.resolve().then(async () => {
                const navigation = await clients.chat.navigation();
                return buildChatThreadNavigation(
                  navigation.threads.map((thread) => ({
                    ...(thread.executing === undefined ? {} : { executing: thread.executing }),
                    ...(thread.awaitingInput === undefined
                      ? {}
                      : { awaitingInput: thread.awaitingInput }),
                    ...(thread.awaitingKind === undefined
                      ? {}
                      : { awaitingKind: thread.awaitingKind }),
                    ...(thread.turnStartedAt === undefined
                      ? {}
                      : { turnStartedAt: thread.turnStartedAt }),
                    ...(thread.liveStep === undefined ? {} : { liveStep: thread.liveStep }),
                    followUpOpen: thread.followUpOpen,
                    ...(thread.projectId === undefined
                      ? {}
                      : { projectId: String(thread.projectId) }),
                    providerInstanceId: String(thread.providerInstanceId),
                    readSequence: 0,
                    threadId: String(thread.id),
                    title: thread.title,
                    updatedAt: thread.updatedAt,
                    ...(thread.completedAt === undefined
                      ? {}
                      : { completedAt: thread.completedAt }),
                    ...(thread.snooze === undefined ? {} : { snooze: thread.snooze }),
                  })),
                );
              }),
              Promise.resolve().then(async () =>
                codeTodoThreadRows(await clients.code.navigation()),
              ),
              Promise.resolve().then(async () => {
                const navigation = await clients.workThread.navigation();
                return buildWorkThreadNavigation(navigation.threads, navigation.runtime);
              }),
            ]);
            return {
              hostId: slot.hostId,
              bridge: slot.bridge,
              chat: chat.status === "fulfilled" ? chat.value : [],
              code: code.status === "fulfilled" ? code.value : [],
              work: work.status === "fulfilled" ? work.value : [],
            };
          }),
        ),
      ]);
      if (!signal.aborted) {
        setProjects(
          projectResults.flatMap((result) => (result.status === "fulfilled" ? result.value : [])),
        );
        setThreadRows(
          navigationResults.flatMap((result) =>
            result.status === "fulfilled" ? [result.value] : [],
          ),
        );
      }
    },
    [transports],
  );
  useVisibleRefresh(refresh, revision, 30_000);
  return { projects, threadRows };
}
