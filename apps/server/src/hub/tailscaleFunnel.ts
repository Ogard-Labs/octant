// The built-in front for the public entrance: Tailscale Funnel, through the
// local `tailscale` tool. Funnel listens publicly only on 443, 8443 and 10000,
// ends TLS in the daemon on this machine, and proxies only to
// http://127.0.0.1 (https://tailscale.com/kb/1223/funnel,
// https://tailscale.com/kb/1311/tailscale-funnel). These commands run only
// when the person turns the front on or off, or pauses remote access.

import type { PublicFunnelPort } from "@octant/contracts";
import {
  tailscaleBinaryCandidates,
  type TailscaleExec,
  type TailscaleExecResult,
} from "./tailscaleCliDaemon";

export type FunnelChange =
  | { readonly status: "done" }
  | {
      readonly status: "refused";
      /** `funnel-not-allowed`: the tailnet policy, HTTPS, or MagicDNS stops it; the person fixes that in Tailscale. */
      readonly kind: "funnel-not-allowed" | "daemon-not-reachable";
    };

export interface TailscaleFunnel {
  readonly on: (input: {
    readonly publicPort: PublicFunnelPort;
    readonly localPort: number;
  }) => Promise<FunnelChange>;
  readonly off: (publicPort: PublicFunnelPort) => Promise<FunnelChange>;
}

export function createTailscaleFunnel(options: {
  readonly exec: TailscaleExec;
  readonly platform: NodeJS.Platform;
}): TailscaleFunnel {
  const run = async (args: ReadonlyArray<string>): Promise<TailscaleExecResult> => {
    let last: TailscaleExecResult = { exitCode: null, stdout: "", stderr: "" };
    for (const file of tailscaleBinaryCandidates(options.platform)) {
      last = await options.exec(file, args);
      if (last.exitCode !== null) return last;
    }
    return last;
  };
  const outcome = (result: TailscaleExecResult): FunnelChange => {
    if (result.exitCode === 0) return { status: "done" };
    if (result.exitCode !== null && /funnel|https|magicdns|policy|attr/i.test(result.stderr)) {
      return { status: "refused", kind: "funnel-not-allowed" };
    }
    return { status: "refused", kind: "daemon-not-reachable" };
  };
  return {
    on: async ({ publicPort, localPort }) =>
      outcome(
        await run([
          "funnel",
          "--bg",
          "--yes",
          `--https=${publicPort}`,
          `http://127.0.0.1:${localPort}`,
        ]),
      ),
    off: async (publicPort) => outcome(await run(["funnel", `--https=${publicPort}`, "off"])),
  };
}
