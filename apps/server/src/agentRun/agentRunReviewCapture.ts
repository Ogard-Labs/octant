import {
  decodeAgentRunReviewSnapshot,
  decodeUtcTimestamp,
  type AgentRunReviewSnapshot,
  type ProviderExecutionPolicy,
} from "@octant/contracts";
import { GitMutationPort } from "../code/gitMutationPort";
import { GitObservationPort } from "../code/gitObservationPort";

export interface AgentRunReviewCapture {
  readonly begin: (
    input: {
      readonly checkoutRoot: string;
      readonly runId: string;
      readonly executionPolicy: ProviderExecutionPolicy;
      readonly baseTree?: string;
      /** Rechecks the original workspace identity and current writable authority. */
      readonly authorize: (signal: AbortSignal) => Promise<boolean>;
    },
    signal: AbortSignal,
  ) => Promise<AgentRunReviewCaptureLease | undefined>;
}
export interface AgentRunReviewCaptureLease {
  readonly baseTree: string;
  readonly finish: (signal: AbortSignal) => Promise<AgentRunReviewSnapshot | undefined>;
}

/** Comparisons retain bounded private diff text and never create permanent Git refs. */
export function createAgentRunReviewCapture(
  options: {
    readonly mutation?: GitMutationPort;
    readonly observation?: GitObservationPort;
  } = {},
): AgentRunReviewCapture {
  const mutation = options.mutation ?? new GitMutationPort();
  const observation = options.observation ?? new GitObservationPort({ maxDiffBytes: 65_536 });
  return {
    async begin(input, signal) {
      if (input.executionPolicy === "plan" || !(await input.authorize(signal))) return undefined;
      const scope = {
        checkoutRoot: input.checkoutRoot,
        checkoutId: input.runId,
        executionPolicy: input.executionPolicy,
        retention: "comparison" as const,
      };
      const before = await mutation.snapshotWorkingTree(scope, signal);
      if (before.status !== "captured") return undefined;
      if (signal.aborted) return undefined;
      return {
        baseTree: input.baseTree ?? before.snapshot.worktree,
        async finish(finishSignal) {
          try {
            if (!(await input.authorize(finishSignal))) return undefined;
            const after = await mutation.snapshotWorkingTree(scope, finishSignal);
            if (after.status !== "captured") return undefined;
            const result = await observation.readTreeDiff(
              {
                checkoutRoot: input.checkoutRoot,
                from: input.baseTree ?? before.snapshot.worktree,
                to: after.snapshot.worktree,
              },
              finishSignal,
            );
            if (result.status !== "ready" || !(await input.authorize(finishSignal)))
              return undefined;
            const paths = result.paths.filter((path) => path.length <= 2048).slice(0, 128);
            let diff = result.diff.text.slice(0, 65_536);
            let truncated =
              result.diff.truncated ||
              diff.length < result.diff.text.length ||
              paths.length < result.paths.length;
            const snapshot = () => ({
              capturedAt: decodeUtcTimestamp(new Date().toISOString()),
              baseTree: input.baseTree ?? before.snapshot.worktree,
              resultTree: after.snapshot.worktree,
              changedPaths: paths,
              diff,
              truncated,
            });
            while (JSON.stringify(snapshot()).length > 120_000) {
              truncated = true;
              if (diff.length > 0) diff = diff.slice(0, Math.floor(diff.length / 2));
              else paths.pop();
            }
            return decodeAgentRunReviewSnapshot(snapshot());
          } catch {
            return undefined;
          }
        },
      };
    },
  };
}
