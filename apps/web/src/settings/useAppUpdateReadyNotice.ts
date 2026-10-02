import type { AppUpdateState } from "@octant/contracts/app-updates";
import { useEffect, useState } from "react";
import type { OctantHostBridge } from "../shell/hostBridge";

export function useAppUpdateReadyNotice(
  subscribe: OctantHostBridge["subscribeAppUpdateState"],
): readonly [boolean, () => void] {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (subscribe === undefined) return;
    let previousStatus: AppUpdateState["status"] | undefined;
    return subscribe((state) => {
      if (state.status === "ready" && previousStatus !== "ready") setReady(true);
      previousStatus = state.status;
    });
  }, [subscribe]);

  return [ready, () => setReady(false)];
}
