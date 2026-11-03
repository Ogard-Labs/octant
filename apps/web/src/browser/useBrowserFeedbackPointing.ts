import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { OctantHostBridge } from "../shell/hostBridge";
import type { ProductFeedback } from "./useProductFeedback";

type PointInput = Parameters<ProductFeedback["prepare"]>[0];
interface Owner {
  readonly contextId: string | undefined;
  readonly threadId: string | undefined;
  readonly native: boolean;
  readonly bridge: OctantHostBridge | undefined;
  readonly prepare: ProductFeedback["prepare"];
  readonly cancelPrepare: ProductFeedback["cancelPrepare"];
  readonly pauseRefresh: ProductFeedback["pauseRefresh"];
  readonly unavailableReason: string | undefined;
}
interface PointRequest {
  readonly owner: Owner;
  readonly id: string;
  active: boolean;
  seen: boolean;
  reading: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

/** One explicit pane gesture; correlation is not Browser authority or a capture token. */
export function useBrowserFeedbackPointing(input: {
  readonly contextId: string | undefined;
  readonly threadId: string | undefined;
  readonly native: boolean;
  readonly bridge?: OctantHostBridge;
  readonly feedback: Pick<ProductFeedback, "prepare" | "cancelPrepare" | "pauseRefresh">;
  readonly unavailableReason?: string;
}) {
  const owner = useMemo<Owner>(
    () => ({
      contextId: input.contextId,
      threadId: input.threadId,
      native: input.native,
      bridge: input.bridge,
      prepare: input.feedback.prepare,
      cancelPrepare: input.feedback.cancelPrepare,
      pauseRefresh: input.feedback.pauseRefresh,
      unavailableReason: input.unavailableReason,
    }),
    [
      input.contextId,
      input.threadId,
      input.native,
      input.bridge,
      input.feedback.prepare,
      input.feedback.cancelPrepare,
      input.feedback.pauseRefresh,
      input.unavailableReason,
    ],
  );
  const latest = useRef(owner);
  latest.current = owner;
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const request = useRef<PointRequest | undefined>(undefined);
  const [state, setState] = useState<{
    owner: Owner;
    pointing: boolean;
    message: string | undefined;
  }>(() => ({ owner, pointing: false, message: undefined }));
  const finish = useCallback((owned: PointRequest, message?: string) => {
    if (!owned.active) return;
    owned.active = false;
    if (owned.timer !== undefined) clearTimeout(owned.timer);
    owned.owner.cancelPrepare();
    owned.owner.pauseRefresh(false);
    if (
      owned.owner.native &&
      owned.owner.contextId !== undefined &&
      owned.owner.threadId !== undefined
    )
      void owned.owner.bridge
        ?.selectBrowserSurfacePoint?.({
          contextId: owned.owner.contextId,
          threadId: owned.owner.threadId,
          enabled: false,
          requestId: owned.id,
        })
        .catch(() => undefined);
    if (request.current === owned) request.current = undefined;
    if (alive.current && latest.current === owned.owner)
      setState({ owner: owned.owner, pointing: false, message });
  }, []);
  const select = useCallback(
    async (owned: PointRequest, point: PointInput) => {
      if (!owned.active || owned.reading || latest.current !== owned.owner) return;
      owned.reading = true;
      try {
        await owned.owner.prepare(point);
      } finally {
        finish(owned);
      }
    },
    [finish],
  );

  useEffect(
    () => () => {
      if (request.current?.owner === owner) finish(request.current);
    },
    [owner, finish],
  );
  useEffect(() => {
    if (!owner.native || owner.bridge?.subscribeBrowserSurfaceState === undefined) return;
    // Inspect every ordered host event, before React can coalesce state updates.
    return owner.bridge.subscribeBrowserSurfaceState((next) => {
      const owned = request.current;
      if (
        owned?.owner !== owner ||
        !owned.active ||
        latest.current !== owner ||
        next.contextId !== owner.contextId
      )
        return;
      const selected = next.pointSelection;
      if (selected === undefined || selected.requestId !== owned.id) {
        if (owned.seen && !owned.reading)
          finish(
            owned,
            "Pointing ended or moved to another Browser panel. Choose the element again.",
          );
        else if (selected !== undefined && owned.seen)
          finish(owned, "Pointing moved to another Browser panel. Choose the element again.");
        return;
      }
      owned.seen = true;
      if (selected.status === "selected" && owner.contextId !== undefined)
        void select(owned, {
          contextId: owner.contextId,
          point: selected.point,
          selectionId: selected.selectionId,
        });
    });
  }, [owner, finish, select]);

  const cancel = useCallback(() => {
    if (request.current?.owner === owner) finish(request.current);
  }, [owner, finish]);
  const toggle = useCallback(() => {
    const previous = request.current;
    if (previous?.owner === owner && previous.active) {
      finish(previous);
      return;
    }
    if (
      owner.unavailableReason !== undefined ||
      owner.contextId === undefined ||
      owner.threadId === undefined
    ) {
      setState({
        owner,
        pointing: false,
        message: owner.unavailableReason ?? "Open a Browser page before pointing.",
      });
      return;
    }
    if (
      owner.native &&
      (owner.bridge?.selectBrowserSurfacePoint === undefined ||
        owner.bridge.subscribeBrowserSurfaceState === undefined)
    ) {
      setState({
        owner,
        pointing: false,
        message: "This app build cannot select a native Browser element.",
      });
      return;
    }
    const owned: PointRequest = {
      owner,
      id: crypto.randomUUID(),
      active: true,
      seen: false,
      reading: false,
    };
    request.current = owned;
    owner.pauseRefresh(true);
    setState({ owner, pointing: true, message: undefined });
    owned.timer = setTimeout(
      () => finish(owned, "Pointing timed out. Choose the element again."),
      60_000,
    );
    if (owner.native)
      void owner.bridge
        ?.selectBrowserSurfacePoint?.({
          contextId: owner.contextId,
          threadId: owner.threadId,
          enabled: true,
          requestId: owned.id,
        })
        .catch((error: unknown) => {
          finish(owned, error instanceof Error ? error.message : "Native pointing is unavailable.");
        });
    // Invoke replies are deliberately not adopted: a late reply must not replace
    // newer ordered state, rearm a cancelled gesture or consume another pane.
  }, [owner, finish]);
  const headlessPoint = useCallback(
    (point: { readonly x: number; readonly y: number }, revision: number | undefined) => {
      const owned = request.current;
      if (
        owned?.owner !== owner ||
        owner.native ||
        owner.contextId === undefined ||
        revision === undefined
      )
        return;
      void select(owned, {
        contextId: owner.contextId,
        point,
        expectedObservationRevision: revision,
      });
    },
    [owner, select],
  );
  const visible = state.owner === owner ? state : { pointing: false, message: undefined };
  return { pointing: visible.pointing, message: visible.message, toggle, cancel, headlessPoint };
}
