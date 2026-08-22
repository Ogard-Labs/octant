import type { AgentRunCenterSummary } from "@octant/contracts";
import {
  AgentRunClientFailure,
  type AgentRunClient,
} from "@octant/client-runtime/agent-run-client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  agentRunTransportFailureMessage,
  buildAgentsCenterServerQuery,
  filterAgentsCenterRows,
  type AgentsCenterClientFilters,
  type AgentsCenterModeFilter,
  type AgentsCenterStatusFilter,
} from "./agentsCenterModel";

export type AgentsCenterListState =
  | { readonly status: "loading" }
  | {
      readonly status: "ready";
      readonly items: readonly AgentRunCenterSummary[];
      readonly nextCursor?: string;
    }
  | { readonly status: "unavailable"; readonly message: string };

export interface AgentsCenterControllerOptions {
  readonly client: AgentRunClient;
  readonly pageLimit?: number;
}

export interface AgentsCenterController {
  readonly statusFilter: AgentsCenterStatusFilter;
  readonly modeFilter: NonNullable<AgentsCenterModeFilter>;
  readonly projectId: string | undefined;
  readonly providerInstanceId: string | undefined;
  readonly parentThreadId: string | undefined;
  readonly search: string;
  readonly list: AgentsCenterListState;
  readonly visibleItems: readonly AgentRunCenterSummary[];
  readonly selectedId: string | undefined;
  readonly notice: string | undefined;
  setStatusFilter(filter: AgentsCenterStatusFilter): void;
  setModeFilter(filter: NonNullable<AgentsCenterModeFilter>): void;
  setProjectId(projectId: string | undefined): void;
  setProviderInstanceId(providerInstanceId: string | undefined): void;
  setParentThreadId(parentThreadId: string | undefined): void;
  setSearch(search: string): void;
  retryList(): void;
  select(runId: string | undefined): void;
  setNotice(message: string | undefined): void;
  clearNotice(): void;
}

const DEFAULT_PAGE_LIMIT = 100;

export function useAgentsCenterController(
  options: AgentsCenterControllerOptions,
): AgentsCenterController {
  const { client } = options;
  const pageLimit = options.pageLimit ?? DEFAULT_PAGE_LIMIT;
  const [statusFilter, setStatusFilter] = useState<AgentsCenterStatusFilter>("all");
  const [modeFilter, setModeFilter] = useState<NonNullable<AgentsCenterModeFilter>>("all");
  const [projectId, setProjectId] = useState<string | undefined>(undefined);
  const [providerInstanceId, setProviderInstanceId] = useState<string | undefined>(undefined);
  const [parentThreadId, setParentThreadId] = useState<string | undefined>(undefined);
  const [search, setSearch] = useState("");
  const [list, setList] = useState<AgentsCenterListState>({ status: "loading" });
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [listGeneration, setListGeneration] = useState(0);
  const listAbort = useRef<AbortController | undefined>(undefined);

  const clientFilters: AgentsCenterClientFilters = useMemo(
    () => ({
      status: statusFilter,
      mode: modeFilter,
      search,
      ...(projectId === undefined ? {} : { projectId }),
      ...(providerInstanceId === undefined ? {} : { providerInstanceId }),
      ...(parentThreadId === undefined ? {} : { parentThreadId }),
    }),
    [modeFilter, parentThreadId, projectId, providerInstanceId, search, statusFilter],
  );

  useEffect(() => {
    const controller = new AbortController();
    listAbort.current?.abort();
    listAbort.current = controller;
    setList({ status: "loading" });
    void client
      .center(buildAgentsCenterServerQuery(clientFilters, pageLimit))
      .then((response) => {
        if (controller.signal.aborted) return;
        setList({
          status: "ready",
          items: response.items,
          ...(response.nextCursor === undefined ? {} : { nextCursor: response.nextCursor }),
        });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setList({
          status: "unavailable",
          message: agentRunTransportFailureMessage(
            error,
            "Agents Center is unavailable right now.",
          ),
        });
      });
    return () => controller.abort();
  }, [client, clientFilters, pageLimit, listGeneration]);

  const visibleItems = useMemo(() => {
    if (list.status !== "ready") return [];
    return filterAgentsCenterRows(list.items, clientFilters);
  }, [clientFilters, list]);

  const retryList = useCallback(() => setListGeneration((generation) => generation + 1), []);
  const select = useCallback((runId: string | undefined) => setSelectedId(runId), []);
  const clearNotice = useCallback(() => setNotice(undefined), []);

  return useMemo(
    () => ({
      statusFilter,
      modeFilter,
      projectId,
      providerInstanceId,
      parentThreadId,
      search,
      list,
      visibleItems,
      selectedId,
      notice,
      setStatusFilter,
      setModeFilter,
      setProjectId,
      setProviderInstanceId,
      setParentThreadId,
      setSearch,
      retryList,
      select,
      setNotice,
      clearNotice,
    }),
    [
      clearNotice,
      list,
      modeFilter,
      notice,
      parentThreadId,
      projectId,
      providerInstanceId,
      retryList,
      search,
      select,
      selectedId,
      statusFilter,
      visibleItems,
    ],
  );
}
