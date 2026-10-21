import type { ExtensionClient } from "@octant/client-runtime/extension-client";
import type { McpServerSignInView } from "@octant/contracts/extension-rpc";
import { useCallback, useEffect, useRef, useState } from "react";
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

  const ask = useCallback(
    async (request: Parameters<typeof client.mcpServerSignIn>[0]) => {
      setBusy(true);
      try {
        const next = await client.mcpServerSignIn(request);
        setView(next);
        return next;
      } catch {
        setView({
          kind: "refused",
          reason: "unavailable",
          message: "Sign-in is unavailable right now.",
        });
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [client],
  );

  useEffect(() => {
    let cancelled = false;
    client
      .mcpServerSignIn({ kind: "status", ...target })
      .then((next) => {
        if (cancelled) return;
        if (next.kind === "signed-out" && props.autoBegin === true) {
          void ask({ kind: "begin", ...target });
          return;
        }
        setView(next);
      })
      .catch(() => {
        if (!cancelled) setView(undefined);
      });
    return () => {
      cancelled = true;
    };
    // The target is the two ids; a new object each render must not re-ask.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, extensionId, componentId]);

  useEffect(() => {
    if (view?.kind !== "awaiting-consent") return;
    const attemptId = view.attemptId;
    polling.current = setTimeout(() => {
      void ask({ kind: "poll", ...target, attemptId });
    }, props.pollIntervalMs ?? 2_000);
    return () => clearTimeout(polling.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, ask, props.pollIntervalMs]);

  if (view === undefined || view.kind === "not-applicable") return null;
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
        {signIn}
      </div>
    );
  }
  if (view.kind === "sign-in-again") {
    return (
      <div className="mcp-sign-in">
        <span className="mcp-sign-in__state" role="status">
          {view.reason === "revoked" ? "Access was revoked" : "The sign-in expired"}
        </span>
        {signIn}
      </div>
    );
  }
  if (view.kind === "awaiting-consent") {
    return (
      <div className="mcp-sign-in">
        <span className="mcp-sign-in__state" role="status">
          Finish signing in in your browser.{" "}
          <a href={view.authorizationUrl} rel="noreferrer" target="_blank">
            Open the sign-in page
          </a>
        </span>
      </div>
    );
  }
  if (view.kind === "signed-in") {
    return (
      <div className="mcp-sign-in">
        <span className="mcp-sign-in__state" role="status">
          Signed in through {view.issuer}
        </span>
        <OctantButton
          disabled={props.disabled || busy}
          onClick={() => void ask({ kind: "sign-out", ...target })}
          size="sm"
          type="button"
          variant="ghost"
        >
          Sign out
        </OctantButton>
      </div>
    );
  }
  return (
    <div className="mcp-sign-in">
      <span className="mcp-sign-in__state" role="status">
        {view.message}
      </span>
      {view.reason === "no-sign-in-offered" ? null : signIn}
    </div>
  );
}
