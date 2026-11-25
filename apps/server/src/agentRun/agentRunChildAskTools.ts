import type { CodeThread, ImageJob, WindowId } from "@octant/contracts";
import { decodeImageGenerationScopeId } from "@octant/contracts";
import type { CredentialOperation } from "@octant/plugin-api/credential-request";
import type { CredentialRequests } from "../credentials/credentialRequests";
import { registeredCredentialOperations } from "../credentials/credentialRequestTools";
import { createCredentialTool } from "../credentials/credentialTool";
import { createThreadImageAgentTools } from "../image/imageAgentTools";
import type { ProjectMemoryAccess } from "../projectMemory/projectMemoryAccess";
import type { AppManagedToolSet } from "../providers/appManagedToolSet";
import { ROUTINE_HOST_SCOPE_ID } from "../routineHostScope";
import {
  whileChildHolds,
  whileChildRuns,
  type AgentRunChildResources,
  type AgentRunChildToolHost,
} from "./agentRunChildTools";

/**
 * `octant_memory` for a child of a thread in a Project. Reads are open; a
 * write follows the rule its parent's does, at the child's own level, and one
 * that needs confirming is refused where nobody is at the child's window. An
 * entry written with nobody asked names the run that wrote it.
 */
export function childMemoryTools(input: {
  readonly host: AgentRunChildToolHost;
  readonly memory: Pick<ProjectMemoryAccess, "toolsFor">;
}): AppManagedToolSet | undefined {
  const { host } = input;
  return whileChildHolds(
    host,
    input.memory.toolsFor({
      // With no window the host's own scope stands in, where nobody confirms.
      windowId: host.window() ?? ROUTINE_HOST_SCOPE_ID,
      mode: host.mode,
      threadId: host.parentThreadId,
      writerId: host.runId,
      projectId: host.projectId === undefined ? undefined : String(host.projectId),
      nobodyToConfirm: () => !host.attended(),
      writeRefusal: () =>
        host.executionPolicy === "plan"
          ? "This child run is read-only, so it cannot change Project memory. Mention the change in your reply instead."
          : undefined,
      fullAccess: () => host.executionPolicy === "full-access",
    }),
  );
}

type ImageToolInput = Parameters<typeof createThreadImageAgentTools>[0];

/**
 * `octant_create_image` for an attended child outside Plan. The card and the
 * finished images are the parent thread's, where the person is; the child may
 * revise, save and reference only images it made itself and files of its own
 * folder.
 */
export function childImageTools(
  input: Omit<
    ImageToolInput,
    "windowId" | "threadKind" | "scopeId" | "unattended" | "fullAccess" | "refusal" | "save"
  > & {
    readonly host: AgentRunChildToolHost;
    readonly saveUnder: (folder: string) => NonNullable<ImageToolInput["save"]>["write"];
  },
): AppManagedToolSet | undefined {
  const { host, saveUnder, ...image } = input;
  const windowId = host.window();
  if (!host.attended() || host.mode === "chat" || windowId === undefined) return undefined;
  const { folder } = host;
  const made = new Set<string>();
  const own = (jobs: ReadonlyArray<ImageJob>) => jobs.filter((job) => made.has(String(job.id)));
  return whileChildHolds(
    host,
    createThreadImageAgentTools({
      ...image,
      windowId,
      threadKind: host.mode === "work" ? "work-thread" : "code-thread",
      scopeId: decodeImageGenerationScopeId(host.parentThreadId),
      jobs: {
        enqueue: async (job) => {
          const queued = await image.jobs.enqueue(job);
          made.add(String(queued.id));
          return queued;
        },
        listByScope: (scopeId) => own(image.jobs.listByScope(scopeId)),
        whenTerminal: (jobId) => image.jobs.whenTerminal(jobId),
        readArtifact: (jobId, attachmentId) => image.jobs.readArtifact(jobId, attachmentId),
      },
      fullAccess: () => host.executionPolicy === "full-access",
      refusal: () =>
        host.current() && host.attended()
          ? undefined
          : "This child run can no longer generate images.",
      ...(folder === undefined || !host.authority.filesystem
        ? {}
        : {
            save: {
              posture: () =>
                !host.current()
                  ? "refuse"
                  : host.executionPolicy === "approval-gated"
                    ? "ask"
                    : "allow",
              write: saveUnder(folder),
            },
          }),
    }),
  );
}

/**
 * `octant_credential` for an attended Code child outside Plan: registered
 * operations only, each on its own one-use card in the parent's conversation.
 * A saved command runs in a thread's checkout under that thread's own command
 * policy, so a child is offered none, and no secret of a thread's reaches it.
 */
export function childCredentialTools(input: {
  readonly host: AgentRunChildToolHost;
  readonly service: CredentialRequests;
  readonly operations: () => ReadonlyArray<CredentialOperation>;
  readonly readParent: () => CodeThread | undefined;
  readonly windowCurrent: (windowId: WindowId) => boolean;
}): AppManagedToolSet | undefined {
  const { host } = input;
  const windowId = host.window();
  const parent = input.readParent();
  if (host.mode !== "code" || !host.attended() || windowId === undefined || parent === undefined)
    return undefined;
  const tools = createCredentialTool({
    registered: registeredCredentialOperations({
      service: input.service,
      windowId: String(windowId),
      thread: parent,
      // The card waits on the parent's thread at the child's own level.
      readThread: () => {
        const thread = input.readParent();
        return thread === undefined || !host.current()
          ? undefined
          : { ...thread, executionPolicy: host.executionPolicy };
      },
      operations: input.operations,
      windowCurrent: () => {
        const owner = host.window();
        return (
          owner !== undefined && String(owner) === String(windowId) && input.windowCurrent(owner)
        );
      },
    }),
  });
  return tools.definitions.length === 0 ? undefined : whileChildHolds(host, tools);
}

/**
 * `octant_computer` for an attended child outside Plan, as its own owner: no
 * grant of its parent's covers it, and its grants and screen reservation end
 * with the run.
 */
export function childComputerTools(input: {
  readonly host: AgentRunChildToolHost;
  readonly resources: AgentRunChildResources;
  readonly tools: AppManagedToolSet | undefined;
}): AppManagedToolSet | undefined {
  const { host, tools } = input;
  if (tools === undefined || !host.attended()) return undefined;
  return whileChildRuns({
    host,
    resources: input.resources,
    tools,
    acquire: () => async () => {
      await tools.execute({
        name: "octant_computer",
        inputJson: JSON.stringify({ operation: "stop" }),
      });
    },
  });
}
