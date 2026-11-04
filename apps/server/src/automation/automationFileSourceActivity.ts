import type { AutomationRun, AgentRunLifecycleStatus } from "@octant/contracts";
import { isAgentRunActiveStatus, isAutomationRunLifecycleActive } from "@octant/domain";
import type { OwnedProcessReceipt } from "../process/nodeOwnedProcessReceipt";

export interface AutomationFileActivityPorts {
  readonly readRun: (runId: string) => AutomationRun | undefined;
  readonly readChildren: (
    parentThreadId: string,
  ) => ReadonlyArray<{ readonly lifecycleStatus: AgentRunLifecycleStatus }>;
  readonly readProcessReceipts: () => Promise<ReadonlyArray<OwnedProcessReceipt>>;
}

/** Existing receipts establish possible Project activity, never the author of a file. */
export async function readAutomationFileSourceActivity(input: {
  readonly canonicalRoot: string;
  readonly activityWindow: ReadonlyArray<string>;
  readonly activeRun: AutomationRun | undefined;
  readonly ports: AutomationFileActivityPorts;
}): Promise<"busy" | "quiet" | "unknown"> {
  if (input.activeRun !== undefined && isAutomationRunLifecycleActive(input.activeRun.lifecycle))
    return "busy";
  let busy = false;
  try {
    for (const id of input.activityWindow) {
      const run = input.ports.readRun(id);
      if (run === undefined) return "unknown";
      if (isAutomationRunLifecycleActive(run.lifecycle)) busy = true;
      if (
        run.threadId !== undefined &&
        input.ports
          .readChildren(String(run.threadId))
          .some((child) => isAgentRunActiveStatus(child.lifecycleStatus))
      )
        busy = true;
    }
    const root = input.canonicalRoot.replace(/\/+$/, "");
    for (const receipt of await input.ports.readProcessReceipts()) {
      // RepositoryTestProcessPort owns this existing cwd:argv:pid receipt spelling.
      const separator = receipt.ownerId.indexOf(":[");
      const pidSeparator = receipt.ownerId.lastIndexOf(":");
      if (
        separator < 1 ||
        pidSeparator <= separator ||
        receipt.ownerId.slice(pidSeparator + 1) !== String(receipt.pid)
      )
        return "unknown";
      const argv: unknown = JSON.parse(receipt.ownerId.slice(separator + 1, pidSeparator));
      if (!Array.isArray(argv) || !argv.every((argument) => typeof argument === "string"))
        return "unknown";
      const cwd = receipt.ownerId.slice(0, separator);
      if (!cwd.startsWith("/")) return "unknown";
      if (cwd === root || cwd.startsWith(`${root}/`)) busy = true;
    }
  } catch {
    return "unknown";
  }
  return busy ? "busy" : "quiet";
}
