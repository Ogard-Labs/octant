import type { ThreadLiveStep } from "@octant/contracts";
import { toolDisplayName, toolKind } from "../transcript/toolKinds";

/**
 * A file's own name from a checkout-relative or folded path ("…/notes.md"),
 * or nothing when the argument is not one path (a patch's first line, a
 * command), which a verb and a file name would misreport.
 */
function fileName(argument: string | undefined): string | undefined {
  if (argument === undefined || /\s/.test(argument)) return undefined;
  const leaf = argument
    .split(/[\\/]/)
    .filter((segment) => segment.length > 0 && segment !== "…")
    .at(-1);
  return leaf === undefined || leaf.length === 0 ? undefined : leaf;
}

/** A folder listing's own tool names, which the shared tool kinds read as other work. */
function listsAFolder(tool: string): boolean {
  const name = tool
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
  return name === "ls" || name === "listdir" || name === "listfiles" || name === "listdirectory";
}

/**
 * What a running turn is doing, in the plain words a working sidebar row shows
 * under its title: "Running bun bench.ts", "Editing composerThreadDraft.ts",
 * "Reading notes.md". It reads only the live step the host already redacted
 * and bounded, so it never says more than the step carries: one tool at a
 * time, with no count of the files a turn has read.
 */
export function liveStepWords(step: ThreadLiveStep): string {
  if (step.kind === "waiting") {
    return step.reason === "approval" ? "Waiting for approval" : "Waiting for your answer";
  }
  const { tool, argument } = step;
  if (listsAFolder(tool)) {
    const folder = fileName(argument);
    return folder === undefined ? "Listing files" : `Listing ${folder}`;
  }
  if (/todo/i.test(tool)) return "Updating the plan";
  switch (toolKind(tool)) {
    case "command":
      return argument === undefined ? "Running a command" : `Running ${argument}`;
    case "edit": {
      const file = fileName(argument);
      return file === undefined ? "Editing files" : `Editing ${file}`;
    }
    case "read": {
      const file = fileName(argument);
      return file === undefined ? "Reading files" : `Reading ${file}`;
    }
    case "search":
      return argument === undefined ? "Searching files" : `Searching for ${argument}`;
    case "web":
      return /search/i.test(tool) ? "Searching the web" : "Reading a web page";
    case "agent":
      return "Running a subagent";
    default:
      return `Using ${toolDisplayName(tool)}`;
  }
}
