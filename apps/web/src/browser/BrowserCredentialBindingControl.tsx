import { browserProfileChoiceOf } from "@octant/domain";
import { browserProfileLabel } from "./browserProfileCopy";
import { useEffect, useId, useRef, useState, type RefObject } from "react";
import type { BrowserAutomationClient } from "@octant/client-runtime/browser-automation-client";
import {
  decodeBrowserCredentialCommand,
  type BrowserCredentialGrant,
  type BrowserCredentialResult,
  type BrowserCredentialTarget,
} from "@octant/contracts/browser-credential-use";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantConfirmDialog } from "../ui/base/OctantConfirmDialog";
import { OctantDialogPresence } from "../ui/base/OctantDialogPresence";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { OctantField, OctantFieldLabel, OctantFieldDescription } from "../ui/base/OctantField";
import { OctantAlert } from "../ui/base/OctantAlert";

type FillReview = Extract<
  BrowserCredentialResult,
  { readonly kind: "browser-credential-fill-review" }
>;
type Review = Extract<BrowserCredentialResult, { readonly kind: "browser-credential-review" }>;
export interface BrowserCredentialBindingControlProps {
  readonly client: Pick<BrowserAutomationClient, "manageCredentialUse">;
  readonly context: Pick<BrowserCredentialTarget, "contextId" | "threadId" | "mode">;
  readonly profile: BrowserCredentialTarget["profile"];
  readonly held: boolean;
  /**
   * The toolbar's more menu opens the review: each new number asks for it, and
   * the control then draws no button of its own. Focus returns to `restoreFocus`.
   */
  readonly openRequest?: number;
  readonly restoreFocus?: RefObject<HTMLElement | null>;
}

/** The person's selected-item permission, separate from Continue and from store unlock. */
export function BrowserCredentialBindingControl(props: BrowserCredentialBindingControlProps) {
  const fieldId = useId();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [loading, setLoading] = useState(false);
  const [accountId, setAccountId] = useState("");
  const [vaultId, setVaultId] = useState("");
  const [itemId, setItemId] = useState("");
  const [scope, setScope] = useState<"project" | "task">(
    props.profile.kind === "private" ? "task" : "project",
  );
  const [review, setReview] = useState<Review>();
  const [fillReview, setFillReview] = useState<FillReview>();
  const [fillState, setFillState] = useState<"review" | "filled" | "done">("review");
  const [progress, setProgress] = useState("Checking the selected item…");
  const fillPlan = useRef<string | undefined>(undefined);
  const [grants, setGrants] = useState<ReadonlyArray<BrowserCredentialGrant>>([]);
  const [message, setMessage] = useState<string>();
  const trigger = useRef<HTMLButtonElement>(null);
  const request = useRef<AbortController | undefined>(undefined);
  const cancelling = useRef(false);
  useEffect(
    () => () => {
      request.current?.abort();
      if (fillPlan.current !== undefined)
        void props.client
          .manageCredentialUse?.(
            decodeBrowserCredentialCommand({
              kind: "cancel-browser-credential-fill",
              contextId: props.context.contextId,
              threadId: props.context.threadId,
              mode: props.context.mode,
              planId: fillPlan.current,
            }),
          )
          .catch(() => undefined);
    },
    [],
  );

  const openReview = useRef<() => void>(() => undefined);
  const { openRequest } = props;
  useEffect(() => {
    if (openRequest !== undefined && openRequest > 0) openReview.current();
  }, [openRequest]);

  const manage = props.client.manageCredentialUse;
  if (manage === undefined) return null;
  const validIds = [accountId, vaultId, itemId].every((id) => /^[a-z0-9]{26}$/i.test(id));
  const close = () => {
    if (cancelling.current) return;
    request.current?.abort();
    const planId = fillPlan.current;
    if (planId !== undefined) {
      fillPlan.current = undefined;
      cancelling.current = true;
      const cancelController = new AbortController();
      request.current = cancelController;
      setPending(true);
      setProgress("Cancelling the selected fill…");
      void manage
        .call(
          props.client,
          decodeBrowserCredentialCommand({
            kind: "cancel-browser-credential-fill",
            contextId: props.context.contextId,
            threadId: props.context.threadId,
            mode: props.context.mode,
            planId,
          }),
          cancelController.signal,
        )
        .then((result) => {
          setPending(false);
          setFillState("done");
          if (result.kind !== "browser-credential-fill-outcome") {
            setMessage(
              "Cancellation could not be confirmed. Check the page; a credential effect may already have started.",
            );
            return;
          }
          if (result.effect !== "none") {
            setMessage(result.message);
            return;
          }
          setFillReview(undefined);
          setOpen(false);
        })
        .catch(() => {
          setPending(false);
          setFillState("done");
          setMessage(
            "Cancellation could not be confirmed. Check the page; a credential effect may already have started.",
          );
        })
        .finally(() => {
          cancelling.current = false;
        });
      return;
    }
    setFillReview(undefined);
    setPending(false);
    setLoading(false);
    setReview(undefined);
    setMessage(undefined);
    setOpen(false);
  };
  const send = async (
    kind: "review" | "allow" | "list" | "revoke" | "prepare-fill" | "confirm-fill" | "submit-fill",
    grantId?: string,
  ) => {
    if (pending) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setPending(true);
    setMessage(undefined);
    setProgress(
      kind === "prepare-fill"
        ? "Reviewing the selected login form…"
        : kind === "confirm-fill"
          ? "Filling the reviewed fields…"
          : kind === "submit-fill"
            ? "Submitting the reviewed form…"
            : "Checking the selected item…",
    );
    if (kind === "list") setGrants([]);
    try {
      const context = {
        contextId: props.context.contextId,
        threadId: props.context.threadId,
        mode: props.context.mode,
      };
      const command =
        kind === "prepare-fill"
          ? { kind: "prepare-browser-credential-fill", ...context, grantId }
          : kind === "confirm-fill" || kind === "submit-fill"
            ? {
                kind:
                  kind === "confirm-fill"
                    ? "confirm-browser-credential-fill"
                    : "submit-browser-credential-fill",
                ...context,
                planId: fillPlan.current,
              }
            : kind === "review"
              ? {
                  kind: "review-browser-credential",
                  ...context,
                  item: { store: "onepassword", accountId, vaultId, itemId },
                }
              : kind === "allow"
                ? {
                    kind: "allow-browser-credential",
                    ...context,
                    reviewId: review?.reviewId,
                    scope,
                  }
                : kind === "revoke"
                  ? { kind: "revoke-browser-credential", ...context, grantId }
                  : { kind: "list-browser-credential-grants", ...context };
      const result = await manage.call(
        props.client,
        decodeBrowserCredentialCommand(command),
        controller.signal,
      );
      if (controller.signal.aborted) return;
      if (result.kind === "browser-credential-fill-review") {
        setFillReview(result);
        fillPlan.current = result.planId;
        setFillState("review");
        setReview(undefined);
      } else if (result.kind === "browser-credential-fill-outcome") {
        setMessage(result.message);
        setFillState(
          result.status === "filled" && result.effect === "completed" ? "filled" : "done",
        );
        if (result.status !== "filled") fillPlan.current = undefined;
      } else if (result.kind === "browser-credential-review") setReview(result);
      else if (result.kind === "browser-credential-grants") {
        setGrants(result.grants);
        setReview(undefined);
        if (kind === "allow")
          setMessage(
            "Login permission recorded. It must be checked again before use. Review the login form to approve a fill.",
          );
        if (kind === "revoke") setMessage("Login permission revoked.");
      } else {
        setGrants([]);
        setMessage(result.message);
        setReview(undefined);
      }
    } catch {
      if (!controller.signal.aborted) {
        setGrants([]);
        setMessage("The request could not finish. Review the item again before allowing it.");
        setReview(undefined);
      }
    } finally {
      if (request.current === controller) {
        setPending(false);
        setLoading(false);
      }
    }
  };
  const openDialog = () => {
    setOpen(true);
    setLoading(true);
    void send("list");
  };
  openReview.current = openDialog;
  return (
    <>
      {props.openRequest === undefined ? (
        <OctantButton ref={trigger} type="button" size="sm" variant="ghost" onClick={openDialog}>
          Login permission
        </OctantButton>
      ) : null}
      <OctantDialogPresence>
        {open ? (
          <OctantConfirmDialog
            title="Browser login permission"
            restoreFocus={props.restoreFocus ?? trigger}
            confirmLabel={
              fillReview !== undefined
                ? fillState === "review"
                  ? "Fill selected fields"
                  : fillState === "filled"
                    ? "Submit sign-in form"
                    : "Close"
                : review === undefined
                  ? "Review item"
                  : "Allow selected item"
            }
            confirmDisabled={
              pending || loading || !props.held || (!review && !fillReview && !validIds)
            }
            onCancel={close}
            onConfirm={() => {
              if (fillReview !== undefined) {
                if (fillState === "done") close();
                else void send(fillState === "review" ? "confirm-fill" : "submit-fill");
              } else void send(review === undefined ? "review" : "allow");
            }}
            details={
              <div className="host-settings__controls">
                {pending ? (
                  <p role="status">{loading ? "Checking current login permissions…" : progress}</p>
                ) : null}
                {message === undefined ? null : <OctantAlert>{message}</OctantAlert>}
                {!props.held ? (
                  <p>
                    Take over this page or wait for the agent's sign-in handoff to review an item.
                  </p>
                ) : null}
                {fillReview === undefined && grants.length === 0 && !loading ? (
                  <p>No current login permission for this page.</p>
                ) : null}
                {(fillReview === undefined ? grants : []).map((grant) => (
                  <div key={grant.grantId}>
                    <p className="break-all">
                      {grant.metadata.title} · {grant.target.topOrigin} ·{" "}
                      {grant.scope.kind === "project" ? "This Project" : "This task"}
                    </p>
                    <OctantButton
                      size="sm"
                      type="button"
                      variant="outline"
                      disabled={pending || !props.held}
                      onClick={() => void send("prepare-fill", grant.grantId)}
                    >
                      Review login form
                    </OctantButton>
                    <OctantButton
                      size="sm"
                      type="button"
                      variant="outline"
                      disabled={pending}
                      onClick={() => void send("revoke", grant.grantId)}
                    >
                      Revoke permission
                    </OctantButton>
                  </div>
                ))}
                {fillReview !== undefined ? (
                  <div>
                    <p className="break-all">Selected item: {fillReview.metadata.title}</p>
                    <p className="break-all">Account: {fillReview.metadata.item.accountId}</p>
                    <p className="break-all">Vault: {fillReview.metadata.item.vaultId}</p>
                    <p className="break-all">Item: {fillReview.metadata.item.itemId}</p>
                    <p>
                      Profile:{" "}
                      {browserProfileLabel(browserProfileChoiceOf(fillReview.target.profile))}
                    </p>
                    <p className="break-all">Exact site: {fillReview.target.topOrigin}</p>
                    <p>Top frame only. Iframes are not included.</p>
                    <p>
                      Fields: {fillReview.usernameLabel} and {fillReview.passwordLabel}
                    </p>
                    <p className="break-all">Submit to: {fillReview.submissionOrigin}</p>
                    <p>
                      Both sites must be saved on this item. If either is missing, sign in manually
                      or correct the item’s saved websites, then review again.
                    </p>
                    <p className="break-all">Return site: {fillReview.target.topOrigin}</p>
                    <p>
                      The website receives this credential and can retain or reflect it. Browser
                      observations are paused during fill and submission. Fill does not confirm
                      sign-in. Complete MFA or CAPTCHA yourself, then check the page before handing
                      it back.
                    </p>
                  </div>
                ) : review === undefined ? (
                  <>
                    <OctantField>
                      <OctantFieldLabel htmlFor={`${fieldId}-account`}>
                        1Password account ID
                      </OctantFieldLabel>
                      <OctantInput
                        id={`${fieldId}-account`}
                        autoComplete="off"
                        spellCheck={false}
                        value={accountId}
                        disabled={pending}
                        maxLength={26}
                        onChange={(event) => setAccountId(event.target.value.trim())}
                      />
                      <OctantFieldDescription>
                        Use the exact 26-character account ID, not an account name.
                      </OctantFieldDescription>
                    </OctantField>
                    <OctantField>
                      <OctantFieldLabel htmlFor={`${fieldId}-vault`}>Vault ID</OctantFieldLabel>
                      <OctantInput
                        id={`${fieldId}-vault`}
                        autoComplete="off"
                        spellCheck={false}
                        value={vaultId}
                        disabled={pending}
                        maxLength={26}
                        onChange={(event) => setVaultId(event.target.value.trim())}
                      />
                    </OctantField>
                    <OctantField>
                      <OctantFieldLabel htmlFor={`${fieldId}-item`}>Item ID</OctantFieldLabel>
                      <OctantInput
                        id={`${fieldId}-item`}
                        autoComplete="off"
                        spellCheck={false}
                        value={itemId}
                        disabled={pending}
                        maxLength={26}
                        onChange={(event) => setItemId(event.target.value.trim())}
                      />
                      <OctantFieldDescription>
                        Review only this item. Never paste a password or one-time code.
                      </OctantFieldDescription>
                    </OctantField>
                  </>
                ) : (
                  <div>
                    <p className="break-all">Selected item: {review.metadata.title}</p>
                    <p className="break-all">Account: {review.metadata.item.accountId}</p>
                    <p className="break-all">Vault: {review.metadata.item.vaultId}</p>
                    <p className="break-all">Item: {review.metadata.item.itemId}</p>
                    <p className="break-all">Exact site: {review.target.topOrigin}</p>
                    <p>Top frame only. Iframes are not included.</p>
                    <p>
                      Profile: {browserProfileLabel(browserProfileChoiceOf(review.target.profile))}
                    </p>
                    <OctantSelectField
                      aria-label="Login permission scope"
                      value={scope}
                      disabled={pending}
                      options={
                        props.profile.kind === "private"
                          ? [{ id: "task", label: "This task and page only" }]
                          : [
                              { id: "project", label: "This Project's eligible threads" },
                              { id: "task", label: "This task and page only" },
                            ]
                      }
                      onValueChange={(value) => setScope(value === "project" ? "project" : "task")}
                    />
                    <OctantButton
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={pending}
                      onClick={() => setReview(undefined)}
                    >
                      Choose another item
                    </OctantButton>
                  </div>
                )}
              </div>
            }
          >
            Review an item before saving permission for this exact website and Browser profile.
            Permission lasts up to eight hours, ends when the host restarts, and does not renew from
            website cookies. Store unlock and website sign-in are separate. Saving permission fills
            nothing; filling and submitting each need your separate approval.
          </OctantConfirmDialog>
        ) : null}
      </OctantDialogPresence>
    </>
  );
}
