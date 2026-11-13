import {
  SIDE_CHAT_LIST_FILES_TOOL_NAME,
  SIDE_CHAT_READ_FILE_TOOL_NAME,
  SIDE_CHAT_SEARCH_FILES_TOOL_NAME,
  type ToolEffectClass,
} from "@octant/contracts";
import { PAST_THREADS_TOOL_NAME } from "@octant/contracts/person-memory";

/**
 * Tools whose call only reads. One the process stopped in the middle of can be
 * called again with no harm; every other tool may already have changed
 * something. A tool is listed here only when every one of its operations
 * reads: a family with one writing operation stays off the list, because the
 * call's arguments are not looked at.
 */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "read",
  "grep",
  "glob",
  "web-fetch",
  "web-search",
  "context-remaining",
  "journal-lookup",
  // "It changes nothing on GitHub": every operation is a read of the
  // Project's delivery repository (github/githubReadToolService.ts).
  "octant_github",
  PAST_THREADS_TOOL_NAME,
  SIDE_CHAT_LIST_FILES_TOOL_NAME,
  SIDE_CHAT_SEARCH_FILES_TOOL_NAME,
  SIDE_CHAT_READ_FILE_TOOL_NAME,
]);

/** Fails closed: a tool nobody declared read-only may have taken effect. */
export function toolEffectClass(toolName: string): ToolEffectClass {
  return READ_ONLY_TOOLS.has(toolName) ? "read-only" : "side-effecting";
}
