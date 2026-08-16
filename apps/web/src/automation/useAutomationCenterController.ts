import type {
  AutomationCommandResult,
  AutomationDefinition,
  AutomationId,
  AutomationRun,
  AutomationSummary,
} from "@octant/contracts";
import {
  AutomationClientFailure,
  type AutomationClient,
  type AutomationClientCommand,
} from "@octant/client-runtime";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * Server-backed state for the Automation Center. The A2 client is the only
 * transport; this hook owns request lifecycles (loading, unavailable,
 * recovery, cancellation) and never invents projection facts.
 */

export type AutomationCenterFilter = "all" | "work" | "code";

export type AutomationListState =
  | { readonly status: "loading" }
  | {
      readonly status: "ready";
      readonly items: readonly AutomationSummary[];
      readonly nextCursor?: string;
    }
  | { readonly status: "unavailable"; readonly message: string };

export type AutomationDetailState =
  | { readonly status: "idle" }
  | { readonly status: "loading"; readonly automationId: string }
  | {
      readonly status: "ready";
      readonly automation: AutomationDefinition;
      readonly runs: readonly AutomationRun[];
    }
  | { readonly status: "unavailable"; readonly automationId: string; readonly message: string };

export type AutomationHistoryState =
  | { readonly status: "collapsed" }
  | { readonly status: "loading" }
  | {
      readonly status: "ready";
      readonly runs: readonly AutomationRun[];
      readonly nextCursor?: string;
      readonly loadingMore: boolean;
    }
  | { readonly status: "unavailable"; readonly message: string };

export type AutomationCommandOutcome =
  | AutomationCommandResult
  | { readonly kind: "automation-transport-failed"; readonly message: string };

export interface AutomationCenterControllerOptions {
  readonly client: AutomationClient;
  readonly pageLimit?: number;
  readonly historyPageLimit?: number;
}

export interface AutomationCenterController {
  readonly filter: AutomationCenterFilter;
  readonly search: string;
  readonly list: AutomationListState;
  readonly detail: AutomationDetailState;
  readonly history: AutomationHistoryState;
  readonly selectedId: string | undefined;
  readonly notice: string | undefined;
  setFilter(filter: AutomationCenterFilter): void;
  setSearch(search: string): void;
  retryList(): void;
  select(automationId: string | undefined): void;
  retryDetail(): void;
  expandHistory(): Promise<void>;
  collapseHistory(): void;
  loadMoreHistory(): Promise<void>;
  execute(
    command: AutomationClientCommand,
    successNotice?: string,
  ): Promise<AutomationCommandOutcome>;
  clearNotice(): void;
}

const DEFAULT_PAGE_LIMIT = 50;
const DEFAULT_HISTORY_PAGE_LIMIT = 20;
const ACTIVE_CONFLICT_NOTICE =
  "This automation already has an active run. Wait for it to finish or cancel it first.";

function failureMessage(error: unknown, fallback: string): string {
  return error instanceof AutomationClientFailure ? error.message : fallback;
}

function isAbort(error: unknown): boolean {
  return error instanceof AutomationClientFailure && error.category === "aborted";
}

export function useAutomationCenterController(
  options: AutomationCenterControllerOptions,
): AutomationCenterController {
  const { client } = options;
  const pageLimit = options.pageLimit ?? DEFAULT_PAGE_LIMIT;
  const historyPageLimit = options.historyPageLimit ?? DEFAULT_HISTORY_PAGE_LIMIT;

  const [filter, setFilter] = useState<AutomationCenterFilter>("all");
  const [search, setSearch] = useState("");
  const [list, setList] = useState<AutomationListState>({ status: "loading" });
  const [detail, setDetail] = useState<AutomationDetailState>({ status: "idle" });
  const [history, setHistory] = useState<AutomationHistoryState>({ status: "collapsed" });
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [listGeneration, setListGeneration] = useState(0);
  const [detailGeneration, setDetailGeneration] = useState(0);

  const listAbort = useRef<AbortController | undefined>(undefined);
  const detailAbort = useRef<AbortController | undefined>(undefined);
  const historyAbort = useRef<AbortController | undefined>(undefined);
  const historyCursorRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    const controller = new AbortController();
    listAbort.current?.abort();
    listAbort.current = controller;
    setList({ status: "loading" });
    const trimmedSearch = search.trim();
    client
      .list(
        {
          mode: filter,
          limit: pageLimit,
          ...(trimmedSearch.length === 0 ? {} : { search: trimmedSearch }),
        },
        controller.signal,
      )
      .then((response) => {
        if (controller.signal.aborted) return;
        setList({
          status: "ready",
          items: response.items,
          ...(response.nextCursor === undefined ? {} : { nextCursor: response.nextCursor }),
        });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || isAbort(error)) return;
        setList({
          status: "unavailable",
          message: failureMessage(error, "Automations are unavailable right now."),
        });
      });
    return () => controller.abort();
  }, [client, filter, search, pageLimit, listGeneration]);

  useEffect(() => {
    detailAbort.current?.abort();
    historyAbort.current?.abort();
    setHistory({ status: "collapsed" });
    if (selectedId === undefined) {
      setDetail({ status: "idle" });
      return;
    }
    const controller = new AbortController();
    detailAbort.current = controller;
    setDetail({ status: "loading", automationId: selectedId });
    client
      .get(selectedId as AutomationId, controller.signal)
      .then((response) => {
        if (controller.signal.aborted) return;
        setDetail({ status: "ready", automation: response.automation, runs: response.runs });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || isAbort(error)) return;
        setDetail({
          status: "unavailable",
          automationId: selectedId,
          message: failureMessage(error, "This automation is unavailable right now."),
        });
      });
    return () => controller.abort();
  }, [client, selectedId, detailGeneration]);

  const fetchHistoryPage = useCallback(
    async (cursor: string | undefined) => {
      if (selectedId === undefined) return;
      const controller = new AbortController();
      historyAbort.current?.abort();
      historyAbort.current = controller;
      setHistory((previous) =>
        cursor !== undefined && previous.status === "ready"
          ? { ...previous, loadingMore: true }
          : { status: "loading" },
      );
      try {
        const response = await client.history(
          {
            automationId: selectedId as AutomationId,
            limit: historyPageLimit,
            ...(cursor === undefined ? {} : { cursor }),
          },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        historyCursorRef.current = response.nextCursor;
        setHistory((previous) => {
          const existing = cursor !== undefined && previous.status === "ready" ? previous.runs : [];
          return {
            status: "ready",
            runs: [...existing, ...response.runs],
            ...(response.nextCursor === undefined ? {} : { nextCursor: response.nextCursor }),
            loadingMore: false,
          };
        });
      } catch (error) {
        if (controller.signal.aborted || isAbort(error)) return;
        setHistory({
          status: "unavailable",
          message: failureMessage(error, "Run history is unavailable right now."),
        });
      }
    },
    [client, historyPageLimit, selectedId],
  );

  const expandHistory = useCallback(() => {
    historyCursorRef.current = undefined;
    return fetchHistoryPage(undefined);
  }, [fetchHistoryPage]);

  const loadMoreHistory = useCallback(async () => {
    const cursor = historyCursorRef.current;
    if (cursor === undefined) return;
    await fetchHistoryPage(cursor);
  }, [fetchHistoryPage]);

  const collapseHistory = useCallback(() => {
    historyAbort.current?.abort();
    historyCursorRef.current = undefined;
    setHistory({ status: "collapsed" });
  }, []);

  const execute = useCallback(
    async (
      command: AutomationClientCommand,
      successNotice?: string,
    ): Promise<AutomationCommandOutcome> => {
      try {
        const result = await client.execute(command);
        if (result.kind === "automation-command-failed") {
          setNotice(result.message);
          return result;
        }
        if (result.kind === "automation-run-active-conflict") {
          setNotice(ACTIVE_CONFLICT_NOTICE);
          return result;
        }
        setNotice(successNotice);
        setListGeneration((generation) => generation + 1);
        setDetailGeneration((generation) => generation + 1);
        return result;
      } catch (error) {
        const message = failureMessage(error, "The automation command did not reach the host.");
        setNotice(message);
        return { kind: "automation-transport-failed", message };
      }
    },
    [client],
  );

  const retryList = useCallback(() => setListGeneration((generation) => generation + 1), []);
  const retryDetail = useCallback(() => setDetailGeneration((generation) => generation + 1), []);
  const select = useCallback((automationId: string | undefined) => {
    setSelectedId(automationId);
  }, []);
  const clearNotice = useCallback(() => setNotice(undefined), []);

  return useMemo(
    () => ({
      filter,
      search,
      list,
      detail,
      history,
      selectedId,
      notice,
      setFilter,
      setSearch,
      retryList,
      select,
      retryDetail,
      expandHistory,
      collapseHistory,
      loadMoreHistory,
      execute,
      clearNotice,
    }),
    [
      filter,
      search,
      list,
      detail,
      history,
      selectedId,
      notice,
      retryList,
      select,
      retryDetail,
      expandHistory,
      collapseHistory,
      loadMoreHistory,
      execute,
      clearNotice,
    ],
  );
}
