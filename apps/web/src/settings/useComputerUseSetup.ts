import { useEffect, useRef, useState } from "react";
import {
  decodeComputerUseStatus,
  type ComputerUseStatus,
} from "@octant/contracts/computer-use-plugin";
import type { OctantHostBridge } from "../shell/hostBridge";
export type ComputerBridge = Pick<
  OctantHostBridge,
  | "getComputerUseStatus"
  | "requestComputerUsePermissions"
  | "openComputerUsePermissionSettings"
  | "checkComputerUseUpdates"
  | "testComputerUse"
>;

export function useComputerUseSetup(bridge: ComputerBridge | undefined, enabled: boolean) {
  const [status, setStatus] = useState<ComputerUseStatus>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const mounted = useRef(false);
  const revision = useRef(0);
  const inFlight = useRef(false);
  useEffect(() => {
    mounted.current = true;
    let active = true;
    setStatus(undefined);
    const read = async () => {
      if (!active || inFlight.current || document.visibilityState === "hidden") return;
      if (bridge?.getComputerUseStatus === undefined) {
        setError("Computer use requires the Octant desktop app on an Apple Silicon Mac.");
        return;
      }
      const request = ++revision.current;
      try {
        const next = decodeComputerUseStatus(await bridge.getComputerUseStatus());
        if (active && request === revision.current) {
          setStatus(next);
          setError(undefined);
        }
      } catch {
        if (active && request === revision.current) {
          setStatus(undefined);
          setError("Computer use status is unavailable. Try rechecking.");
        }
      }
    };
    void read();
    window.addEventListener("focus", read);
    document.addEventListener("visibilitychange", read);
    const timer = setInterval(() => {
      void read();
    }, 3_000);
    return () => {
      active = false;
      mounted.current = false;
      revision.current += 1;
      clearInterval(timer);
      window.removeEventListener("focus", read);
      document.removeEventListener("visibilitychange", read);
    };
  }, [bridge, enabled]);

  async function run(operation: (() => Promise<unknown>) | undefined) {
    if (!mounted.current || operation === undefined || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    const request = ++revision.current;
    try {
      const value = await operation();
      const next = decodeComputerUseStatus(value ?? (await bridge?.getComputerUseStatus?.()));
      if (mounted.current && request === revision.current) {
        setStatus(next);
        setError(undefined);
      }
      return next;
    } catch {
      if (mounted.current) {
        setStatus(undefined);
        setError("Computer use could not complete that request. Recheck its status and try again.");
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  return { status, error, busy, run };
}
