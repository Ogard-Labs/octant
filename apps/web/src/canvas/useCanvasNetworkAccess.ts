import type { CanvasClient } from "@octant/client-runtime/canvas-client";
import type { CanvasId } from "@octant/contracts";
import { useCallback, useEffect, useState } from "react";

export interface CanvasNetworkAccessState {
  /**
   * Whether this Canvas's running pages may fetch through the host. Absent
   * until the host answers, and for a client the host offers no switch to.
   */
  readonly allowed: boolean | undefined;
  readonly busy: boolean;
  readonly message: string | undefined;
  /** Ask the host to turn it on or off. The host decides whether this person may. */
  readonly set: (allowed: boolean) => Promise<void>;
}

/**
 * One Canvas's "Allow network" switch, as the host holds it.
 *
 * The renderer decides nothing here: it shows what the host says and sends the
 * person's choice, and a refusal is shown in the host's words. `offered` is
 * false for a Canvas with no prototype, which has nothing the switch could
 * reach, so the host is not asked.
 */
export function useCanvasNetworkAccess(options: {
  readonly client: Pick<CanvasClient, "networkAccess" | "setNetworkAccess"> | undefined;
  readonly canvasId: CanvasId;
  readonly offered: boolean;
}): CanvasNetworkAccessState {
  const { client, canvasId, offered } = options;
  const [allowed, setAllowed] = useState<boolean | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | undefined>(undefined);

  useEffect(() => {
    const read = client?.networkAccess;
    if (!offered || read === undefined) {
      setAllowed(undefined);
      return;
    }
    let current = true;
    read(canvasId).then(
      (view) => {
        if (current) setAllowed(view.allowed);
      },
      () => {
        if (current) setAllowed(undefined);
      },
    );
    return () => {
      current = false;
    };
  }, [client, canvasId, offered]);

  const set = useCallback(
    async (next: boolean): Promise<void> => {
      const send = client?.setNetworkAccess;
      if (send === undefined) return;
      setBusy(true);
      setMessage(undefined);
      try {
        const result = await send({
          schemaVersion: 1,
          kind: "set-canvas-network-access",
          canvasId,
          allowed: next,
        });
        if (result.kind === "canvas-network-access-refused") setMessage(result.message);
        else setAllowed(result.allowed);
      } catch {
        setMessage("The network setting could not be saved.");
      } finally {
        setBusy(false);
      }
    },
    [client, canvasId],
  );

  return { allowed, busy, message, set };
}
