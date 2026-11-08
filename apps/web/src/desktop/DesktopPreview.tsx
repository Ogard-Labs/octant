import { useEffect, useId, useRef, useState } from "react";
import type { DesktopPaneClient } from "@octant/client-runtime/desktop-pane-client";
import type { DesktopPreviewAnswer, DesktopPreviewRequest } from "@octant/contracts";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantConfirmDialog } from "../ui/base/OctantConfirmDialog";
import { OctantField, OctantFieldGroup, OctantFieldLabel } from "../ui/base/OctantField";
import { OctantInput } from "../ui/base/OctantInput";

type Grant = Extract<DesktopPreviewAnswer, { status: "preview-ready" }>["grant"];
type Review = Extract<DesktopPreviewAnswer, { status: "preview-review" }>;

/** The host decides availability and scope; an uncertain grant is inspected, never resent. */
export function DesktopPreview(props: {
  readonly client: DesktopPaneClient;
  readonly threadId: string;
  readonly leaseId: string;
}) {
  const fieldId = useId();
  const [port, setPort] = useState("5173");
  const [grant, setGrant] = useState<Grant>();
  const [review, setReview] = useState<Review>();
  const [available, setAvailable] = useState(false);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("Checking preview availability…");
  const [invalid, setInvalid] = useState(false);
  const revision = useRef(0);
  const alive = useRef(false);
  const busy = useRef(false);
  const operations = useRef(new Set<AbortController>());
  const { client, threadId, leaseId } = props;
  const ask = async (request: DesktopPreviewRequest) => {
    const controller = new AbortController();
    operations.current.add(controller);
    try {
      return await client.request(request, controller.signal);
    } finally {
      operations.current.delete(controller);
    }
  };
  const refresh = async () => {
    const reading = ++revision.current;
    try {
      const answer = await ask({ kind: "preview-read", threadId, leaseId });
      if (!alive.current || reading !== revision.current) return;
      if (answer.status === "preview-state") {
        setAvailable(answer.available);
        setGrant(answer.grant);
        setNotice(
          answer.available
            ? "Share one running dev server with this desktop."
            : "Preview sharing is unavailable for this desktop.",
        );
      } else if (answer.status === "preview-refused" && answer.reason === "cleanup-unconfirmed") {
        setAvailable(false);
        setGrant(undefined);
        setNotice(
          "Sharing has stopped, but desktop cleanup was not confirmed. Release this desktop before sharing again.",
        );
      } else {
        setAvailable(false);
        setNotice("Preview sharing requires an available local desktop and a window on its host.");
      }
    } catch {
      if (alive.current && reading === revision.current) {
        setAvailable(false);
        setNotice("The host could not confirm this preview. Check the connection and try again.");
      }
    }
  };
  useEffect(() => {
    alive.current = true;
    void refresh();
    const timer = setInterval(() => {
      if (!busy.current && document.visibilityState === "visible") void refresh();
    }, 3000);
    return () => {
      alive.current = false;
      clearInterval(timer);
      for (const controller of operations.current) controller.abort();
      operations.current.clear();
    };
  }, [client, threadId, leaseId]);
  const act = async (request: DesktopPreviewRequest) => {
    if (busy.current) return;
    busy.current = true;
    ++revision.current;
    setPending(true);
    try {
      const answer = await ask(request);
      if (!alive.current) return;
      if (answer.status === "preview-review") setReview(answer);
      else if (answer.status === "preview-ready") {
        setGrant(answer.grant);
        setReview(undefined);
        setNotice("Preview shared with this desktop.");
      } else if (answer.status === "preview-revoked") {
        setGrant(undefined);
        setNotice("Preview sharing stopped. Requests already sent may have taken effect.");
      } else if (answer.status === "preview-refused" && answer.reason === "cleanup-unconfirmed") {
        setAvailable(false);
        setGrant(undefined);
        setReview(undefined);
        setNotice(
          "Sharing has stopped, but desktop cleanup was not confirmed. Release this desktop before sharing again.",
        );
      } else {
        setReview(undefined);
        setNotice(
          "The host refused this preview. Check that the dev server runs in this task’s own worktree, then review again.",
        );
      }
    } catch {
      if (!alive.current) return;
      setReview(undefined);
      setAvailable(false);
      setNotice(
        "Completion was not confirmed. Check the preview state before reviewing again; nothing was resent.",
      );
    } finally {
      busy.current = false;
      if (alive.current) setPending(false);
    }
  };
  return (
    <section aria-label="Desktop preview" className="desktop-preview">
      {grant === undefined ? (
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            const number = Number(port);
            if (!Number.isInteger(number) || number < 1024 || number > 65535) {
              setInvalid(true);
              setNotice("Enter a port from 1024 to 65535.");
              return;
            }
            setInvalid(false);
            void act({ kind: "preview-review", threadId, leaseId, port: number });
          }}
        >
          <OctantFieldGroup>
            <OctantField data-invalid={invalid || undefined}>
              <OctantFieldLabel htmlFor={fieldId}>Dev-server port</OctantFieldLabel>
              <div className="desktop-preview__actions">
                <OctantInput
                  aria-invalid={invalid || undefined}
                  aria-describedby={`${fieldId}-notice`}
                  disabled={!available || pending}
                  id={fieldId}
                  inputMode="numeric"
                  value={port}
                  onChange={(event) => {
                    setPort(event.target.value);
                    setInvalid(false);
                  }}
                />
                <OctantButton
                  disabled={!available || pending}
                  size="sm"
                  type="submit"
                  variant="outline"
                >
                  Review preview
                </OctantButton>
              </div>
            </OctantField>
          </OctantFieldGroup>
        </form>
      ) : (
        <div className="desktop-preview__actions">
          <p>
            Inside this desktop, open <code>{grant.guestUrl}</code>. Shared until{" "}
            {new Date(grant.expiresAt).toLocaleTimeString()}.
          </p>
          <OctantButton
            disabled={pending}
            onClick={() =>
              void act({ kind: "preview-revoke", threadId, leaseId, grantId: grant.grantId })
            }
            size="sm"
            type="button"
            variant="outline"
          >
            Stop sharing
          </OctantButton>
        </div>
      )}
      <p aria-live="polite" className="oct-row-detail" id={`${fieldId}-notice`} role="status">
        {notice}
      </p>
      {review === undefined ? null : (
        <OctantConfirmDialog
          title="Share this dev server with the desktop?"
          confirmLabel="Share preview"
          pending={pending}
          onCancel={() => setReview(undefined)}
          onConfirm={() =>
            void act({ kind: "preview-grant", threadId, leaseId, reviewId: review.reviewId })
          }
        >
          Allow this desktop to reach {review.processName} on this computer at port {review.port}{" "}
          until {new Date(review.expiresAt).toLocaleTimeString()}. Other host ports stay
          unavailable. Stopping the preview ends new requests; requests already sent may have taken
          effect.
        </OctantConfirmDialog>
      )}
    </section>
  );
}
