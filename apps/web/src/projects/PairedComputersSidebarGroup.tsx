import type { FederatedReadItem } from "@octant/client-runtime/host-federation-merged-reads";
import {
  isEnvironmentSelected,
  type EnvironmentSelection,
} from "@octant/client-runtime/environment-selection";
import type { PairedComputerThreadPayload } from "@octant/client-runtime/paired-computer-reads";
import { Monitor } from "../ui/icons";
import { OctantButton } from "../ui/base/OctantButton";

const STATE_LABEL: Readonly<Record<PairedComputerThreadPayload["state"], string | undefined>> = {
  working: "Working",
  "needs-you": "Needs you",
  idle: undefined,
};

/**
 * The Code sidebar's threads on the person's other computers, under this
 * computer's Projects (maintainer request, 2026-11-19). Each computer keeps
 * its rows when it stops answering, marked as not connected and not openable,
 * since nothing there can be reached until it is back. The Environments filter
 * decides which computers are shown; it never changes what anything may do.
 */
export function PairedComputersSidebarGroup(props: {
  readonly threads: ReadonlyArray<FederatedReadItem<PairedComputerThreadPayload>>;
  readonly selection: EnvironmentSelection;
  readonly onOpenThread: (hostId: string, threadId: string) => void;
}) {
  const shown = props.threads.filter((item) =>
    isEnvironmentSelected(props.selection, String(item.ref.hostId)),
  );
  if (shown.length === 0) return null;
  const byComputer = new Map<string, Array<FederatedReadItem<PairedComputerThreadPayload>>>();
  for (const item of shown) {
    const hostId = String(item.ref.hostId);
    byComputer.set(hostId, [...(byComputer.get(hostId) ?? []), item]);
  }
  return (
    <section aria-label="On your other computers" className="project-section">
      <div className="project-section__header sidebar-section">
        <h2>On your other computers</h2>
      </div>
      {[...byComputer.entries()].map(([hostId, threads]) => {
        const computer = threads[0]?.hostDisplayName ?? hostId;
        const stale = threads.some((item) => item.readOnly);
        return (
          <div className="project-block" key={hostId}>
            <div className="project-row" data-folder-state="open">
              <span className="project-row__select justify-start">
                <Monitor aria-hidden="true" size={16} />
                <span className="project-row__copy">
                  <span>
                    {computer}
                    {stale ? <span className="project-row__where"> · not connected</span> : null}
                  </span>
                </span>
              </span>
            </div>
            <ul aria-label={`Threads on ${computer}`} className="project-thread-list">
              {threads.map((item) => {
                const state = STATE_LABEL[item.payload.state];
                return (
                  <li key={item.payload.threadId}>
                    <OctantButton
                      aria-label={`${item.title} on ${computer}`}
                      className="project-thread-row justify-start window-no-drag"
                      disabled={item.readOnly}
                      onClick={() => props.onOpenThread(hostId, item.payload.threadId)}
                      title={item.readOnly ? `${computer} is not connected` : item.title}
                      type="button"
                      variant="bare"
                    >
                      <span className="project-thread-row__title">{item.title}</span>
                      {state === undefined ? null : (
                        <span className="project-thread-row__meta">{state}</span>
                      )}
                    </OctantButton>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </section>
  );
}
