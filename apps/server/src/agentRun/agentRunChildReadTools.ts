import type { CodeThread } from "@octant/contracts";
import type { ImageDescriber } from "../harness/imageDescription";
import { lookToolForThread } from "../image/lookTool";
import type { GithubReadToolService } from "../github/githubReadToolService";
import type { AppManagedToolSet } from "../providers/appManagedToolSet";
import type { TaintAppManagedToolResultsInput } from "../providers/appManagedToolTaint";
import { whileChildHolds, type AgentRunChildToolHost } from "./agentRunChildTools";

/**
 * `octant_look` for a child whose model cannot read images: the files of its
 * own folder. It is offered no attachment of its parent's, and a child handed
 * an image reads it itself, so a Chat child has nothing to look at.
 */
export function childLookTools(input: {
  readonly host: AgentRunChildToolHost;
  readonly describer: Pick<ImageDescriber, "available" | "describe">;
  readonly threadModel: string;
  /** Whether the child's own model takes an image from Octant. */
  readonly readsImages: boolean;
  readonly recordExternalContentIngestion?: TaintAppManagedToolResultsInput["recordExternalContentIngestion"];
  readonly uuid: () => string;
}): AppManagedToolSet | undefined {
  const { host } = input;
  if (host.mode === "chat" || host.folder === undefined || host.projectId === undefined)
    return undefined;
  return whileChildHolds(
    host,
    lookToolForThread({
      describer: input.describer,
      // A child's spend counts against its parent's ceiling, as its turns do.
      threadId: host.parentThreadId,
      readerId: host.runId,
      threadType: host.mode === "work" ? "work-thread" : "code-thread",
      projectId: host.projectId,
      threadModel: input.threadModel,
      readsImages: input.readsImages,
      folder: host.folder,
      ...(input.recordExternalContentIngestion === undefined
        ? {}
        : { recordExternalContentIngestion: input.recordExternalContentIngestion }),
      uuid: input.uuid,
    }),
  );
}

/** `octant_github` for a Code child: its Project's delivery repository, read under the child's own mark. */
export function childGithubTools(input: {
  readonly host: AgentRunChildToolHost;
  readonly github: Pick<GithubReadToolService, "createToolSet">;
  /** The same check the lead's tool passes: the integration is effective. */
  readonly effective: (create: () => AppManagedToolSet) => AppManagedToolSet | undefined;
  readonly readThread: () => CodeThread | undefined;
}): AppManagedToolSet | undefined {
  const { host } = input;
  const window = host.window();
  const thread = input.readThread();
  if (host.mode !== "code" || window === undefined || thread === undefined) return undefined;
  return whileChildHolds(
    host,
    input.effective(() =>
      input.github.createToolSet({
        windowId: window,
        thread,
        readThread: () => (host.window() === undefined ? undefined : input.readThread()),
        readerId: host.runId,
      }),
    ),
  );
}
