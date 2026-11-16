import { randomUUID } from "node:crypto";
import {
  CodeEvidenceBatchResponse,
  CodeOperationResult,
  decodeHostAnswer,
} from "@octant/contracts";
import { parseUnifiedDiff } from "@octant/domain";
import { refusalMessage } from "./agentHost";
import type { OpenedLocalControlSession } from "./localControl";

export type AgentDiff =
  | {
      readonly kind: "ready";
      readonly branch?: string;
      readonly text: string;
      readonly truncated: boolean;
      readonly files: readonly {
        readonly path: string;
        readonly additions: number;
        readonly deletions: number;
      }[];
      readonly missingPaths: readonly string[];
    }
  | { readonly kind: "refused"; readonly message: string };

/** Observe the checkout through the host, then resolve the evidence it returned. */
export async function readAgentDiff(
  session: OpenedLocalControlSession,
  threadId: string,
  checkoutId: string,
): Promise<AgentDiff> {
  try {
    const operationId = randomUUID();
    const response = await session.send({
      path: "/api/code/commands",
      method: "POST",
      body: {
        kind: "observe-git",
        operationId,
        gitOperationId: randomUUID(),
        threadId,
        checkoutId,
        maxDiffBytes: 262_144,
      },
    });
    if (response.status !== 200)
      return {
        kind: "refused",
        message: refusalMessage(response, "Checkout changes could not be read."),
      };
    const result = decodeHostAnswer(CodeOperationResult)(response.body);
    if (String(result.operationId) !== operationId)
      return { kind: "refused", message: "The host returned a different operation." };
    if (result.kind === "operation-failed")
      return { kind: "refused", message: result.failure.message };
    if (result.kind !== "git-observed")
      return { kind: "refused", message: "The host did not return checkout changes." };
    let text = "";
    if (result.diff.byteLength > 0) {
      const evidence = await session.send({
        path: "/api/code/evidence/batch",
        method: "POST",
        body: {
          threadId,
          items: [{ operationId, contentId: String(result.diff.contentId) }],
        },
      });
      if (evidence.status !== 200)
        return {
          kind: "refused",
          message: refusalMessage(evidence, "Diff evidence could not be read."),
        };
      const batch = decodeHostAnswer(CodeEvidenceBatchResponse)(evidence.body);
      if (String(batch.threadId) !== threadId)
        return { kind: "refused", message: "The host returned evidence for a different thread." };
      const item = batch.items.find(
        (entry) =>
          String(entry.operationId) === operationId &&
          String(entry.contentId) === String(result.diff.contentId),
      );
      if (item === undefined) return { kind: "refused", message: "Diff evidence is unavailable." };
      text = item.text;
    }
    const files = parseUnifiedDiff(text).map(({ path, additions, deletions }) => ({
      path,
      additions,
      deletions,
    }));
    const shown = new Set(files.map((file) => file.path));
    return {
      kind: "ready",
      ...(result.head.kind === "branch" ? { branch: result.head.name } : {}),
      text,
      files,
      truncated: result.diff.truncated === true,
      missingPaths: result.changedPaths.map(String).filter((path) => !shown.has(path)),
    };
  } catch {
    return { kind: "refused", message: "Checkout changes could not be read from the host." };
  }
}

/** Keep the host's exact hunk text when opening one file from checkout review. */
export function selectAgentDiff(
  diff: Extract<AgentDiff, { kind: "ready" }>,
  path: string,
): AgentDiff {
  const file = parseUnifiedDiff(diff.text, { retainSource: true }).find(
    (file) => file.path === path,
  );
  if (file?.source !== undefined)
    return {
      ...diff,
      text: diff.text.slice(file.source.start, file.source.end),
      files: diff.files.filter((file) => file.path === path),
      missingPaths: [],
    };
  if (diff.missingPaths.includes(path))
    return { ...diff, text: "", files: [], missingPaths: [path] };
  return {
    kind: "refused",
    message: "That file is no longer in the current checkout changes. Refresh the file list.",
  };
}
