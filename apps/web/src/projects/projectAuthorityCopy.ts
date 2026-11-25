/**
 * What a Project's standing-permission switches say, in one place so a window
 * and a browser the host's own person paired tell the person the same thing.
 */
export const AGENT_MEMORY_WRITES_COPY =
  "Below Full access, agents write memory without asking. Each entry is marked as written by an agent. Full access never asks. Plan never writes.";

export const OWN_TOOLCHAIN_COPY =
  "Type errors and go to definition use the TypeScript this Project installs instead of the one bundled with Octant. That runs code from the repository, so each checkout asks you to allow it first, it never runs in Plan, and it can write the checkout and reach the hosts this Project's network rules allow. Only this computer, or a browser you paired yourself, can change this.";

export const AGENT_MERGE_COPY =
  "Agents merge the pull requests their threads own without asking each time.";

export const AGENT_PULL_REQUEST_COMMENTS_COPY =
  "Below Full access, agents comment on the pull requests their threads own without asking for each post.";
