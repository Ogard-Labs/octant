import type { ExtensionClient } from "@octant/client-runtime/extension-client";
import type { McpServerSignInView } from "@octant/contracts/extension-rpc";
import { useCallback, useEffect, useRef, useState } from "react";
import { McpClientSetupControl } from "./McpClientSetupControl";
import { OctantButton } from "../ui/base/OctantButton";

export interface McpServerSignInControlProps {
  readonly client: Pick<ExtensionClient, "mcpServerSignIn">;
  readonly extensionId: string;
  readonly componentId: string;
  readonly disabled: boolean;
  /** How often an open sign-in is asked about, in milliseconds. */
  readonly pollIntervalMs?: number;
  /** Start the sign-in as soon as the host says the server is signed out; the person just asked to connect. */
  readonly autoBegin?: boolean;
  readonly autoSetup?: boolean;
  readonly onAutoSetup?: () => void;
  readonly registration?: {
    readonly guideUrl: string;
    readonly requestedScopes: readonly string[];
  };
}

/**
 * Sign in to a hosted server a person added. The control reads its state
 * from the host, opens the sign-in page in the browser, asks the host until
 * the page is done, and offers Sign out afterwards. A command server, or one
 * that never asked for a sign-in, shows nothing.
 */
export function McpServerSignInControl(props: McpServerSignInControlProps) {
  const [view, setView] = useState<McpServerSignInView>();
  const [busy, setBusy] = useState(false);
  const { client, extensionId, componentId } = props;
  const target = { extensionId: extensionId as never, componentId: componentId as never };
  const polling = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const requestGeneration = useRef(0);

  const ask = useCallback(
    async (request: Parameters<typeof client.mcpServerSignIn>[0], interactive = true) => {
      const generation = interactive ? ++requestGeneration.current : requestGeneration.current;
      if (interactive) {
        clearTimeout(polling.current);
        polling.current = undefined;
        setBusy(true);
      }
      try {
        const next = await client.mcpServerSignIn(request);
        if (generation !== requestGeneration.current) return undefined;
        setView(next);
        return next;
      } catch {
        if (generation !== requestGeneration.current) return undefined;
        setView((current) => {
          if (request.kind === "poll" || request.kind === "status")
            return {
              kind: "status-unavailable",
              message:
                "Sign-in status is unavailable. Check sign-in or cancel this attempt when the host is available.",
            };
          if (
            request.kind === "sign-out" &&
            (current?.kind === "signed-in" ||
              current?.kind === "sign-in-again" ||
              current?.kind === "sign-out-pending")
          )
            return {
              kind: "sign-out-pending",
              message: "Sign-out is not confirmed. Finish signing out when the host is available.",
            };
          if (
            request.kind === "sign-out" &&
            (current?.kind === "awaiting-consent" ||
              current?.kind === "cancel-pending" ||
              current?.kind === "status-unavailable")
          )
            return {
              kind: "cancel-pending",
              message:
                "Sign-in cancellation is not confirmed. Try Cancel sign-in again when the host is available.",
            };
          return {
            kind: "refused",
            reason: "unavailable",
            message: "Sign-in is unavailable right now.",
          };
        });
        return undefined;
      } finally {
        if (interactive && generation === requestGeneration.current) setBusy(false);
      }
    },
    [client],
  );

  useEffect(() => {
    let cancelled = false;
    const generation = ++requestGeneration.current;
    setBusy(false);
    client
      .mcpServerSignIn({ kind: "status", ...target })
      .then((next) => {
        if (cancelled || generation !== requestGeneration.current) return;
        if (next.kind === "signed-out" && props.autoBegin === true) {
          void ask({ kind: "begin", ...target });
          return;
        }
        setView(next);
      })
      .catch(() => {
        if (!cancelled && generation === requestGeneration.current) setView(undefined);
      });
    return () => {
      cancelled = true;
      ++requestGeneration.current;
    };
    // The target is the two ids; a new object each render must not re-ask.
  }, [client, extensionId, componentId]);

  useEffect(() => {
    if (view?.kind !== "awaiting-consent") return;
    const attemptId = view.attemptId;
    const scheduledGeneration = requestGeneration.current;
    polling.current = setTimeout(() => {
      if (scheduledGeneration !== requestGeneration.current) return;
      void ask({ kind: "poll", ...target, attemptId }, false);
    }, props.pollIntervalMs ?? 2_000);
    return () => clearTimeout(polling.current);
  }, [view, ask, props.pollIntervalMs]);

  if (
    view === undefined ||
    view.kind === "not-applicable" ||
    view.kind === "client-setup" ||
    view.kind === "client-configured"
  )
    return null;
  const setup = (
    <McpClientSetupControl
      key={`${extensionId}:${componentId}`}
      client={client}
      autoOpen={props.autoSetup === true && view.kind === "client-setup-required"}
      {...(props.onAutoSetup === undefined ? {} : { onAutoOpen: props.onAutoSetup })}
      extensionId={extensionId}
      componentId={componentId}
      disabled={props.disabled || busy}
      onSaved={() => {
        void ask({ kind: "status", ...target });
      }}
    />
  );
  const registration =
    props.registration === undefined ? null : (
      <span className="mcp-sign-in__account mcp-sign-in__state">
        <span>
          Use an eligible app you register with this service. Save client setup before signing in.
        </span>
        <a href={props.registration.guideUrl} target="_blank" rel="noreferrer">
          App registration guide
        </a>
        <span>Requested permission: {props.registration.requestedScopes.join(", ")}</span>
      </span>
    );
  if (view.kind === "client-setup-required")
    return (
      <div className="mcp-sign-in">
        <span className="mcp-sign-in__state" role="status">
          {view.message}
        </span>
        {registration}
        {setup}
      </div>
    );
  const signIn = (
    <OctantButton
      disabled={props.disabled || busy}
      onClick={() => void ask({ kind: "begin", ...target })}
      size="sm"
      type="button"
      variant="outline"
    >
      {view.kind === "sign-in-again" ? "Sign in again" : "Sign in"}
    </OctantButton>
  );
  if (view.kind === "signed-out") {
    return (
      <div className="mcp-sign-in">
        <span className="mcp-sign-in__state">Not signed in</span>
        {registration}
        {signIn}
        {setup}
      </div>
    );
  }
  if (view.kind === "sign-in-again") {
    return (
      <div className="mcp-sign-in">
        <span className="mcp-sign-in__state" role="status">
          {view.reason === "account-changed"
            ? "Check the connected account and sign in again"
            : view.reason === "permission-missing"
              ? "The account did not grant the required permission"
              : view.reason === "revoked"
                ? "Access was revoked"
                : "The sign-in expired"}
        </span>
        {registration}
        {signIn}
        {setup}
      </div>
    );
  }
  if (
    view.kind === "awaiting-consent" ||
    view.kind === "cancel-pending" ||
    view.kind === "status-unavailable"
  ) {
    return (
      <div className="mcp-sign-in">
        <span className="mcp-sign-in__state" role="status">
          {view.kind !== "awaiting-consent" ? (
            view.message
          ) : (
            <>
              Finish signing in in your browser.{" "}
              <a href={view.authorizationUrl} rel="noreferrer" target="_blank">
                Open the sign-in page
              </a>
            </>
          )}
        </span>
        {view.kind === "status-unavailable" ? (
          <OctantButton
            disabled={props.disabled || busy}
            onClick={() => void ask({ kind: "status", ...target })}
            size="sm"
            type="button"
            variant="outline"
          >
            Check sign-in
          </OctantButton>
        ) : null}
        <OctantButton
          disabled={props.disabled || busy}
          onClick={() => void ask({ kind: "sign-out", ...target })}
          size="sm"
          type="button"
          variant="ghost"
        >
          Cancel sign-in
        </OctantButton>
      </div>
    );
  }
  if (view.kind === "sign-out-pending")
    return (
      <div className="mcp-sign-in">
        <span className="mcp-sign-in__state" role="status">
          {view.message}
        </span>
        <OctantButton
          disabled={props.disabled || busy}
          onClick={() => void ask({ kind: "sign-out", ...target })}
          size="sm"
          type="button"
          variant="ghost"
        >
          Finish signing out
        </OctantButton>
      </div>
    );
  if (view.kind === "signed-in") {
    return (
      <div className="mcp-sign-in">
        <span className="mcp-sign-in__state" role="status">
          Signed in through {view.issuer}
        </span>
        {props.registration !== undefined || view.account !== undefined ? (
          <span className="mcp-sign-in__account mcp-sign-in__state">
            <span>Reported workspace ID: {view.account?.workspaceId ?? "Not reported"}</span>
            <span>Reported user ID: {view.account?.userId ?? "Not reported"}</span>
            <span>
              Last reported permissions: {view.account?.grantedScopes?.join(", ") ?? "Not reported"}
            </span>
            <span>Tools are checked when selected for an authorized task.</span>
          </span>
        ) : null}
        <OctantButton
          disabled={props.disabled || busy}
          onClick={() => void ask({ kind: "sign-out", ...target })}
          size="sm"
          type="button"
          variant="ghost"
        >
          Sign out
        </OctantButton>
        {setup}
      </div>
    );
  }
  return (
    <div className="mcp-sign-in">
      <span className="mcp-sign-in__state" role="status">
        {view.message}
      </span>
      {view.kind === "refused" && view.reason === "no-sign-in-offered" ? null : (
        <>
          {signIn}
          {setup}
        </>
      )}
    </div>
  );
}
