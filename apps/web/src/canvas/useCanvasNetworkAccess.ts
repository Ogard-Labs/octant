import type { CanvasClient } from "@octant/client-runtime/canvas-client";
import type { CanvasId } from "@octant/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

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
 * The views of each Canvas that are showing its switch in this window. One
 * Canvas is often on screen twice, in the thread and in the sidebar, and each
 * view reads the host for itself; a change made in one is told to the others
 * here. Before this, the thread's prototype ran with the network on while its
 * own chrome still showed no "Network on" mark.
 */
const viewsByCanvas = new Map<string, Set<(allowed: boolean) => void>>();

function watchCanvasNetwork(canvasId: CanvasId, view: (allowed: boolean) => void): () => void {
  const key = String(canvasId);
  const views = viewsByCanvas.get(key) ?? new Set<(allowed: boolean) => void>();
  viewsByCanvas.set(key, views.add(view));
  return () => {
    views.delete(view);
    if (views.size === 0 && viewsByCanvas.get(key) === views) viewsByCanvas.delete(key);
  };
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
  // Whether the host has answered this view's own read with a switch.
  const answered = useRef(false);
  const [readAgain, setReadAgain] = useState(0);

  useEffect(() => {
    const read = client?.networkAccess;
    answered.current = false;
    if (!offered || read === undefined) {
      setAllowed(undefined);
      return;
    }
    let current = true;
    read(canvasId).then(
      (view) => {
        if (!current) return;
        answered.current = true;
        setAllowed(view.allowed);
      },
      () => {
        if (current) setAllowed(undefined);
      },
    );
    // A change made in another view of this Canvas is shown here at once. A
    // view the host has not given a switch takes nobody's word for one: it
    // asks the host again, which refuses it again if it must.
    const unwatch = watchCanvasNetwork(canvasId, (next) => {
      if (answered.current) setAllowed(next);
      else setReadAgain((count) => count + 1);
    });
    return () => {
      current = false;
      unwatch();
    };
  }, [client, canvasId, offered, readAgain]);

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
        else {
          setAllowed(result.allowed);
          for (const view of viewsByCanvas.get(String(canvasId)) ?? []) view(result.allowed);
        }
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
