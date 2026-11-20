import type { LocalServerClient } from "@octant/client-runtime";
import type { CodeThreadId } from "@octant/contracts/code";
import type { LocalServerListener, RemoteServerGrantSource } from "@octant/contracts";
import type { ProjectId } from "@octant/contracts/projects";
import { useState } from "react";
import { useLocalServersController } from "../environment/useLocalServersController";
import {
  REMOTE_OPEN_LIMITS,
  type RemoteOpenMode,
  type RemoteOpenOutcome,
} from "../home/runningServices";
import { OctantButton } from "../ui/base/OctantButton";

/**
 * The servers a thread on another computer has running, where the person
 * follows that thread from this window. Each opens in Octant's own window or
 * the default browser through a grant that computer gives for that thread's
 * listing, so the host re-observes the row and the thread's authority there
 * decides (maintainer decision, 2026-11-20). The page never opens as one of
 * this window's Browser tabs, which belong to threads on this computer.
 */
export function PairedComputerThreadServers(props: {
  readonly client: LocalServerClient;
  readonly threadId: CodeThreadId;
  readonly projectId: ProjectId;
  readonly hostName: string;
  readonly open: (
    source: RemoteServerGrantSource,
    mode: RemoteOpenMode,
  ) => Promise<RemoteOpenOutcome>;
}) {
  const controller = useLocalServersController({
    client: props.client,
    threadId: props.threadId,
    projectId: props.projectId,
    enabled: true,
    poll: true,
  });
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const listeners = (controller.snapshot?.currentCheckout ?? []).filter(
    (listener) => listener.openAvailable,
  );
  if (listeners.length === 0) return null;

  const open = async (listener: LocalServerListener, mode: RemoteOpenMode) => {
    setBusy(String(listener.listenerId));
    setMessage(undefined);
    try {
      const outcome = await props.open(
        {
          surface: "local-servers",
          threadId: props.threadId,
          projectId: props.projectId,
          listenerId: listener.listenerId,
        },
        mode,
      );
      setMessage(outcome.kind === "refused" ? outcome.message : outcome.notice);
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <section aria-label={`Servers on ${props.hostName}`} className="local-servers">
      <ul className="local-servers__list">
        {listeners.map((listener) => {
          const name = `${listener.framework ?? listener.processName} on port ${String(listener.port)}`;
          const working = busy === String(listener.listenerId);
          return (
            <li className="local-servers__row" key={String(listener.listenerId)}>
              <span>{name}</span>
              <OctantButton
                aria-label={`Open ${name} in Octant`}
                disabled={busy !== undefined}
                onClick={() => void open(listener, "octant-browser")}
                size="sm"
                type="button"
                variant="ghost"
              >
                {working ? "Opening…" : "Open in Octant"}
              </OctantButton>
              <OctantButton
                aria-label={`Open ${name} in your default browser`}
                disabled={busy !== undefined}
                onClick={() => void open(listener, "default-browser")}
                size="sm"
                type="button"
                variant="ghost"
              >
                Open in default browser
              </OctantButton>
            </li>
          );
        })}
      </ul>
      <p className="local-servers__state">{REMOTE_OPEN_LIMITS}</p>
      {message === undefined ? null : (
        <p className="local-servers__state" role="status">
          {message}
        </p>
      )}
    </section>
  );
}
