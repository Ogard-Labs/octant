import { useEffect, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { SettingRow } from "../settings/primitives";

export interface ClaudeHelperCommand {
  readonly kind: "status" | "connect" | "disconnect";
  readonly instanceId: string;
}

/** What the host reports. It never carries the token itself. */
export type ClaudeHelperView =
  | { readonly kind: "not-connected" }
  | { readonly kind: "connecting" }
  | { readonly kind: "connected" }
  | { readonly kind: "expired" }
  | { readonly kind: "refused"; readonly reason: string };

export type RunClaudeHelperCommand = (
  command: ClaudeHelperCommand,
) => Promise<ClaudeHelperView | undefined>;

const POLL_MS = 2_000;

/**
 * "Connect Claude for helpers": a Chat subagent runs Claude Code read-only,
 * where it cannot reach the keychain the ordinary Claude sign-in lives in. One
 * browser approval gives Octant a long-lived sign-in for those runs; ordinary
 * Claude turns keep using the normal sign-in.
 */
export function ClaudeHelperSignIn(props: {
  readonly instanceId: string;
  readonly displayName: string;
  readonly disabled: boolean;
  readonly run: RunClaudeHelperCommand;
}) {
  const { instanceId, run } = props;
  const [view, setView] = useState<ClaudeHelperView | undefined>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void run({ kind: "status", instanceId }).then((next) => {
      if (!cancelled && next !== undefined) setView(next);
    });
    return () => {
      cancelled = true;
    };
  }, [instanceId, run]);

  useEffect(() => {
    if (view?.kind !== "connecting") return;
    const timer = setInterval(() => {
      void run({ kind: "status", instanceId }).then((next) => {
        if (next !== undefined) setView(next);
      });
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [instanceId, run, view?.kind]);

  const send = (kind: "connect" | "disconnect") => {
    setBusy(true);
    void run({ kind, instanceId })
      .then((next) => {
        if (next !== undefined) setView(next);
      })
      .finally(() => setBusy(false));
  };

  const connected = view?.kind === "connected";
  return (
    <SettingRow
      description={describe(view)}
      label="Claude for helpers"
      scope="host"
      settingId={`provider-${instanceId}-claude-helpers`}
    >
      {connected ? (
        <OctantButton
          aria-label={`Disconnect Claude for helpers on ${props.displayName}`}
          disabled={props.disabled || busy}
          onClick={() => send("disconnect")}
          size="sm"
          type="button"
          variant="outline"
        >
          Disconnect
        </OctantButton>
      ) : (
        <OctantButton
          aria-label={`Connect Claude for helpers on ${props.displayName}`}
          disabled={props.disabled || busy || view?.kind === "connecting"}
          onClick={() => send("connect")}
          size="sm"
          type="button"
        >
          {view?.kind === "connecting" ? "Waiting for approval…" : "Connect Claude for helpers"}
        </OctantButton>
      )}
    </SettingRow>
  );
}

function describe(view: ClaudeHelperView | undefined): string {
  switch (view?.kind) {
    case "connected":
      return "Connected for helpers. Subagents on Claude Code sign in with it.";
    case "connecting":
      return "Approve the sign-in in the browser window Claude opened.";
    case "expired":
      return "The helper sign-in expired. Connect again so subagents can use Claude Code.";
    case "refused":
      return view.reason;
    default:
      return "Subagents run Claude Code read-only, away from your keychain. Connect once so they can sign in.";
  }
}
