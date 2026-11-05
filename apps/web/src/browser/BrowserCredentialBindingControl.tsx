import { useEffect, useId, useRef, useState } from "react";
import type { BrowserAutomationClient } from "@octant/client-runtime/browser-automation-client";
import {
  decodeBrowserCredentialCommand,
  type BrowserCredentialGrant,
  type BrowserCredentialResult,
  type BrowserCredentialTarget,
} from "@octant/contracts/browser-credential-use";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantConfirmDialog } from "../ui/base/OctantConfirmDialog";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { OctantField, OctantFieldLabel, OctantFieldDescription } from "../ui/base/OctantField";
import { OctantAlert } from "../ui/base/OctantAlert";

type Review = Extract<BrowserCredentialResult, { readonly kind: "browser-credential-review" }>;
export interface BrowserCredentialBindingControlProps {
  readonly client: Pick<BrowserAutomationClient, "manageCredentialUse">;
  readonly context: Pick<BrowserCredentialTarget, "contextId" | "threadId" | "mode">;
  readonly profile: BrowserCredentialTarget["profile"];
  readonly held: boolean;
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
  const [grants, setGrants] = useState<ReadonlyArray<BrowserCredentialGrant>>([]);
  const [message, setMessage] = useState<string>();
  const trigger = useRef<HTMLButtonElement>(null);
  const request = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => request.current?.abort(), []);

  const manage = props.client.manageCredentialUse;
  if (manage === undefined) return null;
  const validIds = [accountId, vaultId, itemId].every((id) => /^[a-z0-9]{26}$/i.test(id));
  const close = () => {
    request.current?.abort();
    setPending(false);
    setLoading(false);
    setReview(undefined);
    setMessage(undefined);
    setOpen(false);
  };
  const send = async (kind: "review" | "allow" | "list" | "revoke", grantId?: string) => {
    if (pending) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setPending(true);
    setMessage(undefined);
    if (kind === "list") setGrants([]);
    try {
      const context = {
        contextId: props.context.contextId,
        threadId: props.context.threadId,
        mode: props.context.mode,
      };
      const command =
        kind === "review"
          ? {
              kind: "review-browser-credential",
              ...context,
              item: { store: "onepassword", accountId, vaultId, itemId },
            }
          : kind === "allow"
            ? { kind: "allow-browser-credential", ...context, reviewId: review?.reviewId, scope }
            : kind === "revoke"
              ? { kind: "revoke-browser-credential", ...context, grantId }
              : { kind: "list-browser-credential-grants", ...context };
      const result = await manage.call(
        props.client,
        decodeBrowserCredentialCommand(command),
        controller.signal,
      );
      if (controller.signal.aborted) return;
      if (result.kind === "browser-credential-review") setReview(result);
      else if (result.kind === "browser-credential-grants") {
        setGrants(result.grants);
        setReview(undefined);
        if (kind === "allow")
          setMessage(
            "Login permission recorded. It must be checked again before use. Automatic filling is not available yet.",
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
  return (
    <>
      <OctantButton
        ref={trigger}
        type="button"
        size="sm"
        variant="ghost"
        onClick={() => {
          setOpen(true);
          setLoading(true);
          void send("list");
        }}
      >
        Login permission
      </OctantButton>
      {open ? (
        <OctantConfirmDialog
          title="Browser login permission"
          restoreFocus={trigger}
          confirmLabel={review === undefined ? "Review item" : "Allow selected item"}
          confirmDisabled={pending || loading || !props.held || (!review && !validIds)}
          onCancel={close}
          onConfirm={() => void send(review === undefined ? "review" : "allow")}
          details={
            <div className="host-settings__controls">
              {pending ? (
                <p role="status">
                  {loading ? "Checking current login permissions…" : "Checking the selected item…"}
                </p>
              ) : null}
              {message === undefined ? null : <OctantAlert>{message}</OctantAlert>}
              {!props.held ? (
                <p>
                  Take over this page or wait for the agent's sign-in handoff to review an item.
                </p>
              ) : null}
              {grants.length === 0 && !loading ? (
                <p>No current login permission for this page.</p>
              ) : null}
              {grants.map((grant) => (
                <div key={grant.grantId}>
                  <p className="break-all">
                    {grant.metadata.title} · {grant.target.topOrigin} ·{" "}
                    {grant.scope.kind === "project" ? "This Project" : "This task"}
                  </p>
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
              {review === undefined ? (
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
                    Profile:{" "}
                    {review.target.profile.kind === "private"
                      ? "Private"
                      : review.target.profile.kind === "project"
                        ? "Project"
                        : "Personal"}
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
          website cookies. Store unlock and website sign-in are separate. This step fills nothing.
        </OctantConfirmDialog>
      ) : null}
    </>
  );
}
