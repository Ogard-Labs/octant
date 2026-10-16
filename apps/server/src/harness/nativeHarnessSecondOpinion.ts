import {
  decodeProviderSessionId,
  type ProjectId,
  type ProviderInstanceId,
} from "@octant/contracts";
import type { ProviderDriver } from "@octant/provider-sdk/driver";
import type { NativeHarnessRouter } from "./nativeHarnessRouter";
import { completeOnce } from "./nativeHarnessSingleShot";
import type { NativeHarnessToolPorts } from "./nativeHarnessTools";

const SECOND_OPINION_TIMEOUT_MS = 60_000;

const SECOND_OPINION_INSTRUCTIONS = [
  "Another model is working on a task and asks for your advice on one question.",
  "Answer plainly and briefly. Your answer is advice the asker may weigh and set aside.",
  "You cannot run tools, read files, or approve anything.",
].join("\n");

export interface NativeHarnessSecondOpinionOptions {
  readonly router: Pick<NativeHarnessRouter, "resolve">;
  readonly resolveDriver: (providerInstanceId: ProviderInstanceId) => ProviderDriver | undefined;
  /** A directory outside every Project, where the advisor's one-shot session starts. */
  readonly scratchRoot: string;
  readonly uuid: () => string;
  readonly complete?: typeof completeOnce;
}

/**
 * The advisor behind `second-opinion`: one question, one tool-less reply, on
 * the model chosen for the `advisor` slot. It reaches no file, shell, or
 * network of the asking thread, so the same port serves Chat, Work, and Code.
 * With no advisor model chosen it answers nothing and the tool says so.
 */
export function createNativeHarnessSecondOpinionPort(
  options: NativeHarnessSecondOpinionOptions,
  scope: { readonly projectId?: ProjectId | undefined },
): NonNullable<NativeHarnessToolPorts["secondOpinion"]> {
  return async ({ question, signal }) => {
    const decision = options.router.resolve({ job: "advisor", projectId: scope.projectId });
    if (decision.kind === "unroutable") return undefined;
    const driver = options.resolveDriver(decision.candidate.providerInstanceId);
    if (driver === undefined) return undefined;
    const asking = (options.complete ?? completeOnce)({
      driver,
      providerInstanceId: decision.candidate.providerInstanceId,
      modelId: decision.candidate.modelId,
      sessionId: decodeProviderSessionId(options.uuid()),
      projectRoot: options.scratchRoot,
      instructions: SECOND_OPINION_INSTRUCTIONS,
      prompt: question,
      timeoutMs: SECOND_OPINION_TIMEOUT_MS,
    });
    // A cancelled turn stops waiting; the one-shot session ends on its own timeout.
    const answer = await (signal === undefined
      ? asking
      : Promise.race([
          asking,
          new Promise<undefined>((resolve) => {
            if (signal.aborted) resolve(undefined);
            signal.addEventListener("abort", () => resolve(undefined), { once: true });
          }),
        ]));
    const trimmed = answer?.trim();
    return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
  };
}
