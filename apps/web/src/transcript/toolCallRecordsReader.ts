import { createThreadExportClient } from "@octant/client-runtime/thread-export-client";
import { useMemo } from "react";
import type { ToolCallRecordsReader } from "./TurnActivityRows";

/**
 * Reads one Chat attempt's or Work turn's kept tool-call records from the
 * host, for the tool rows of that turn. Undefined where the surface has no
 * host address or window capability to read with, and the rows then show
 * their summaries alone. The host answers a local window only, so a paired
 * device's read rejects and the row says the record could not be read.
 */
export function useToolCallRecordsReader(input: {
  readonly serverUrl: string | undefined;
  readonly windowCapability: string | undefined;
  readonly mode: "chat" | "work";
  readonly threadId: string;
  /** The Chat attempt id or the Work turn's request id. */
  readonly turnId: string;
}): ToolCallRecordsReader | undefined {
  const { serverUrl, windowCapability, mode, threadId, turnId } = input;
  return useMemo(() => {
    if (serverUrl === undefined || windowCapability === undefined) return undefined;
    const client = createThreadExportClient({
      baseUrl: serverUrl,
      fetch: globalThis.fetch,
      windowCapability,
    });
    return async () => {
      const result = await client.readToolCallRecords({ mode, threadId, turnId });
      if (result.kind === "refused") throw new Error(result.reason);
      return result.records;
    };
  }, [serverUrl, windowCapability, mode, threadId, turnId]);
}
