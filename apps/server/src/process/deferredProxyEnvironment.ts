import type { ConfinedProcessLaunch } from "./seatbeltProfile";

/** The auth parent ignores this name; only the confined bootstrap promotes it. */
export const DEFERRED_PROXY_SOURCE = "OCTANT_COMMAND_PROXY_URL";
const ENV = "/usr/bin/env";
const PROXY = "${OCTANT_COMMAND_PROXY_URL}";
// This is fixed env(1) syntax, never a shell command or a string containing values.
const PROMOTE = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]
  .map((name) => `${name}=${PROXY}`)
  .concat(["NO_PROXY=", "no_proxy=", "NODE_USE_ENV_PROXY=1"])
  .join(" ");

/** Called only for the inner target after the recipient's sandbox policy is built. */
export function deferredProxyEnvironment(
  executable: string,
  args: ReadonlyArray<string>,
  runtimeMode?: "electron-node",
): ConfinedProcessLaunch {
  return {
    command: ENV,
    args: [
      "-S",
      runtimeMode === "electron-node" ? `${PROMOTE} ELECTRON_RUN_AS_NODE=1` : PROMOTE,
      ENV,
      "-u",
      DEFERRED_PROXY_SOURCE,
      executable,
      ...args,
    ],
  };
}
