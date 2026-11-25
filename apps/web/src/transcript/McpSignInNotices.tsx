import {
  ExtensionClientFailure,
  type ExtensionClient,
} from "@octant/client-runtime/extension-client";
import type { McpServerConnection } from "@octant/contracts/extension-rpc";
import type { ExtensionSelection } from "@octant/contracts/extensions";
import { useCallback, useEffect, useRef, useState } from "react";
import { McpServerSignInControl } from "../extensions/McpServerSignInControl";
import { samePollingData } from "../polling/samePollingData";
import { THREAD_ACTIVITY_RECOVERY_MS } from "../polling/ThreadActivityRevisions";
import { useVisibleRefresh } from "../polling/useVisibleRefresh";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";
import type { McpSignInNoticeProps } from "./McpSignInNotice";
import "../styles/provider-settings.css";
import "./mcp-sign-in-notice.css";

/** How long "Signed in" stays, so a sign-in is seen to finish rather than inferred. */
const SIGNED_IN_NOTICE_MS = 6_000;

// A dismissal outlives a thread switch, which remounts the notice, and ends
// with the window or when the thread no longer waits on that sign-in.
const dismissed = new Set<string>();

const serverKey = (server: McpServerConnection) =>
  `${String(server.extensionId)}/${String(server.componentId)}`;

const serverLabel = (server: McpServerConnection) =>
  server.serverName === server.packageName
    ? server.serverName
    : `${server.packageName} · ${server.serverName}`;

export function McpSignInNotices(
  props: McpSignInNoticeProps & { readonly client: ExtensionClient; readonly threadId: string },
) {
  const { client, mode, threadId, turnActive } = props;
  const [servers, setServers] = useState<ReadonlyArray<McpServerConnection>>([]);
  const [signedIn, setSignedIn] = useState<string>();
  const [changes, setChanges] = useState(0);

  // Held as one string so a new array each render does not read again.
  const refused = props.receipts.filter((receipt) => receipt.selection === undefined);
  const selections = new Map<string, ExtensionSelection>();
  for (const selection of [
    ...props.receipts.flatMap((receipt) =>
      receipt.selection === undefined ? [] : [receipt.selection],
    ),
    ...props.selections,
    // A message already running is this turn, not the next one.
    ...(props.queued ?? []).flatMap((item) =>
      item.status === "accepted" ? [] : (item.payload?.extensionSelections ?? []),
    ),
  ])
    selections.set(JSON.stringify(selection), selection);
  const carried = JSON.stringify({
    selections: [...selections.values()].slice(0, 32),
    references: [...new Set(refused.map((receipt) => receipt.reference.slice(0, 256)))].slice(
      0,
      32,
    ),
  });
  // A name the composer refused while the server could not connect stays
  // refused in the draft; it is resolved again once the thread stops waiting
  // on a sign-in, wherever that sign-in finished.
  const latest = useRef({ refused, onResolveReference: props.onResolveReference });
  latest.current = { refused, onResolveReference: props.onResolveReference };
  const listed = useRef<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const now = new Set(servers.map(serverKey));
    const left = [...listed.current].some((key) => !now.has(key));
    listed.current = now;
    if (left)
      for (const receipt of latest.current.refused)
        void latest.current.onResolveReference(receipt.reference);
  }, [servers]);
  const refresh = useCallback(
    async (signal: AbortSignal) => {
      if (client.mcpServersAwaitingSignIn === undefined) return;
      const draft = JSON.parse(carried) as {
        readonly selections: ReadonlyArray<ExtensionSelection>;
        readonly references: ReadonlyArray<string>;
      };
      try {
        const listed = await client.mcpServersAwaitingSignIn({ mode, threadId, ...draft }, signal);
        if (signal.aborted) return;
        const waiting = new Set(listed.servers.map((server) => `${threadId}/${serverKey(server)}`));
        for (const key of dismissed)
          if (key.startsWith(`${threadId}/`) && !waiting.has(key)) dismissed.delete(key);
        setServers((current) =>
          samePollingData(current, listed.servers) ? current : listed.servers,
        );
      } catch (error) {
        // A host out of reach says nothing about the sign-in, and clearing
        // here would take a half-pasted address with it. A refusal does.
        if (
          !signal.aborted &&
          error instanceof ExtensionClientFailure &&
          error.category === "unauthorized"
        )
          setServers([]);
      }
    },
    [client, mode, threadId, carried],
  );
  // Read again when a turn starts or ends, and after a step of a sign-in.
  useVisibleRefresh(refresh, changes * 2 + (turnActive ? 1 : 0), THREAD_ACTIVITY_RECOVERY_MS);

  useEffect(() => {
    if (signedIn === undefined) return;
    const timer = window.setTimeout(() => setSignedIn(undefined), SIGNED_IN_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [signedIn]);

  const shown = servers.filter((server) => !dismissed.has(`${threadId}/${serverKey(server)}`));
  if (shown.length === 0 && signedIn === undefined) return null;
  return (
    <div className={`mcp-sign-in-notices ${props.className}`}>
      {shown.map((server) => {
        const label = serverLabel(server);
        return (
          <OctantAlert
            action={
              <OctantButton
                aria-label={`Dismiss the ${label} sign-in notice`}
                onClick={() => {
                  dismissed.add(`${threadId}/${serverKey(server)}`);
                  // Only to draw without it; a dismissal asks the host nothing.
                  setServers((current) => [...current]);
                }}
                size="sm"
                type="button"
                variant="ghost"
              >
                Dismiss
              </OctantButton>
            }
            key={serverKey(server)}
            label={`${label} needs sign-in`}
            role="status"
            title={`${label} needs sign-in`}
            tone="warning"
          >
            <p>Once it is signed in, you can use it from the next message.</p>
            <McpServerSignInControl
              client={client}
              componentId={String(server.componentId)}
              disabled={false}
              extensionId={String(server.extensionId)}
              knownToNeedSignIn
              onChanged={(view) => {
                if (view.kind === "signed-in") {
                  setSignedIn(label);
                  setServers((current) =>
                    current.filter((other) => serverKey(other) !== serverKey(server)),
                  );
                }
                setChanges((count) => count + 1);
              }}
            />
          </OctantAlert>
        );
      })}
      {signedIn === undefined ? null : (
        <OctantAlert tone="success">
          <p>Signed in to {signedIn}. You can use it from the next message.</p>
        </OctantAlert>
      )}
    </div>
  );
}
