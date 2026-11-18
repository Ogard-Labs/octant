import { useEffect } from "react";
import type { OctantHostBridge } from "../shell/hostBridge";
import { confirmFilesClose } from "./filesCloseGuard";

/**
 * Answers the desktop's Files close checks for this window. A `check` first
 * acknowledges `checking`, then asks the Files close registry about every
 * draft in the window. When the answer is allow, the document goes inert
 * before the reply leaves, so nothing in the page moves again until the
 * window closes or the desktop releases it. A `release` for the active
 * request aborts that request's open prompt — answers it Cancel — and
 * restores the document; a late completion after release can neither allow
 * nor freeze anything. A check that arrives while another is active is
 * answered Cancel rather than sharing the first one's consent.
 */
export function useDesktopFilesClose(hostBridge: OctantHostBridge | undefined): void {
  const subscribe = hostBridge?.subscribeFilesCloseRequest;
  const reply = hostBridge?.replyFilesClose;
  useEffect(() => {
    if (subscribe === undefined || reply === undefined) return;
    let activeId = 0;
    let controller: AbortController | undefined;
    let priorInert: boolean | undefined;
    const finish = () => {
      if (priorInert !== undefined) {
        document.body.inert = priorInert;
        priorInert = undefined;
      }
      controller = undefined;
      activeId = 0;
    };
    const unsubscribe = subscribe((request) => {
      if (request.kind === "release") {
        if (request.requestId !== activeId) return;
        controller?.abort();
        finish();
        return;
      }
      if (activeId !== 0) {
        void reply(request.requestId, "cancel").catch(() => undefined);
        return;
      }
      const requestId = request.requestId;
      const control = new AbortController();
      activeId = requestId;
      controller = control;
      const current = () => activeId === requestId && !control.signal.aborted;
      void (async () => {
        try {
          // A refused reply means the desktop no longer holds this request;
          // the prompt it belongs to must never produce an allow.
          if (!(await reply(requestId, "checking"))) throw new Error("reply refused");
          if (!current()) return;
          const allowed = await confirmFilesClose(undefined, undefined, control.signal);
          if (!current()) return;
          if (!allowed) {
            await reply(requestId, "cancel");
            if (current()) finish();
            return;
          }
          // The document locks before the answer leaves: the main process
          // must never see an allow beside a page that still accepts input.
          priorInert = document.body.inert;
          document.body.inert = true;
          if (!(await reply(requestId, "allow"))) throw new Error("reply refused");
          // The request now stays held: only its release unlocks it.
        } catch {
          if (!current()) return;
          try {
            await reply(requestId, "cancel");
          } catch {
            // The refusal could not be delivered either; the desktop treats
            // an unanswered check as refused on its own.
          }
          if (current()) finish();
        }
      })();
    });
    return () => {
      unsubscribe();
      controller?.abort();
      finish();
    };
  }, [subscribe, reply]);
}
