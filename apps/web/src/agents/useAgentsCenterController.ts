import type { AgentRunCenterSummary } from "@octant/contracts";
import {
  AgentRunClientFailure,
  type AgentRunClient,
} from "@octant/client-runtime/agent-run-client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDebouncedValue } from "../lib/useDebouncedValue";
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
  | {
      /** A newer query is in flight; the previous rows stay on screen. */
      readonly status: "refreshing";
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
  // The input keeps the immediate value; only the query and the local filter
  // wait for typing to settle, so one pause produces one request.
  const debouncedSearch = useDebouncedValue(search, 250);
  const [list, setList] = useState<AgentsCenterListState>({ status: "loading" });
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [listGeneration, setListGeneration] = useState(0);
  const listAbort = useRef<AbortController | undefined>(undefined);

  const clientFilters: AgentsCenterClientFilters = useMemo(
    () => ({
      status: statusFilter,
      mode: modeFilter,
      search: debouncedSearch,
      ...(projectId === undefined ? {} : { projectId }),
      ...(providerInstanceId === undefined ? {} : { providerInstanceId }),
      ...(parentThreadId === undefined ? {} : { parentThreadId }),
    }),
    [debouncedSearch, modeFilter, parentThreadId, projectId, providerInstanceId, statusFilter],
  );

  useEffect(() => {
    const controller = new AbortController();
    listAbort.current?.abort();
    listAbort.current = controller;
    // A filter or search change must not blank rows that are still a truthful
    // answer to the previous query. Keep them and mark the list busy.
    setList((previous) =>
      previous.status === "ready" || previous.status === "refreshing"
        ? {
            status: "refreshing",
            items: previous.items,
            ...(previous.nextCursor === undefined ? {} : { nextCursor: previous.nextCursor }),
          }
        : { status: "loading" },
    );
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
          message: agentRunTransportFailureMessage(error, "Agents are unavailable right now."),
        });
      });
    return () => controller.abort();
  }, [client, clientFilters, pageLimit, listGeneration]);

  const visibleItems = useMemo(() => {
    // While a changed query is in flight the rows on screen are the previous
    // query's answer, not a partial reading of the new one.
    if (list.status === "refreshing") return list.items;
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
