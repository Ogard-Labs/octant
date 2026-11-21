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
  /**
   * The thread runs in its own worktree on that computer. A server in the
   * shared Project folder is no one thread's, so the host refuses its grant.
   */
  readonly inOwnWorktree: boolean;
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
  // A listing still in hand from another thread would offer that thread's
  // servers under this one's ids, which the host refuses as not listed.
  const snapshot =
    controller.snapshot !== undefined &&
    String(controller.snapshot.threadId) === String(props.threadId)
      ? controller.snapshot
      : undefined;
  const listeners = (snapshot?.currentCheckout ?? []).filter(
    (listener) => listener.openAvailable && listener.health === "listening",
  );
  // A failed first read sets an error status; a failed poll after a good one
  // keeps the last rows and only records the message, so both are shown.
  const listingFailure =
    controller.errorMessage === undefined ? null : (
      <p className="local-servers__state" role="status">
        {`Couldn't list this thread's servers on ${props.hostName}. ${controller.errorMessage}`}
      </p>
    );
  if (listeners.length === 0) {
    return listingFailure === null ? null : (
      <section aria-label={`Servers on ${props.hostName}`} className="local-servers">
        {listingFailure}
      </section>
    );
  }
  // The same facts the host's grant policy refuses on, so a row never offers
  // a control that is certain to fail; the host still decides every grant.
  const refusal = (listener: LocalServerListener): string | undefined =>
    listener.startSource !== "octant"
      ? `Octant didn't start this server, so it opens only on ${props.hostName}.`
      : props.inOwnWorktree
        ? undefined
        : `This server runs in the Project folder, not this thread's own worktree, so it opens only on ${props.hostName}.`;

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
          const reason = refusal(listener);
          if (reason !== undefined) {
            return (
              <li className="local-servers__row" key={String(listener.listenerId)}>
                <span>{name}</span>
                <span className="local-servers__state">{reason}</span>
              </li>
            );
          }
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
      {listingFailure}
      {message === undefined ? null : (
        <p className="local-servers__state" role="status">
          {message}
        </p>
      )}
    </section>
  );
}
