import { useMemo } from "react";
import { usePlanUsageClient, usePlanUsageInstances } from "../usage/PlanUsageContext";
import { PlanUsageMeters } from "../usage/PlanUsageMeters";
import { railUsageReadings, resetPhrase, type RailUsageReading } from "../usage/railUsageReading";
import { useProviderUsageSnapshot } from "../usage/useProviderUsageSnapshot";

export interface InboxPlanUsageEntry {
  readonly name: string;
  readonly reading: RailUsageReading;
  readonly resets: string | undefined;
}

/**
 * How each provider account's plan reads, from the host observation the rail
 * and the composer already hold, so the Inbox asks for nothing new. Empty
 * while no account reports a window: a card with no figure would claim a limit
 * nobody reported.
 */
export function useInboxPlanUsage(): ReadonlyArray<InboxPlanUsageEntry> {
  const { snapshot, now } = useProviderUsageSnapshot(usePlanUsageClient());
  const instances = usePlanUsageInstances();
  return useMemo(() => {
    if (snapshot === undefined) return [];
    const names = new Map(instances.map((instance) => [String(instance.id), instance.displayName]));
    return railUsageReadings(
      snapshot.entries.filter((entry) => names.has(String(entry.providerInstanceId))),
      now,
    ).flatMap((reading) => {
      const name = names.get(reading.providerInstanceId);
      if (name === undefined) return [];
      const resets = reading.windows.flatMap((window) => {
        const phrase = resetPhrase(reading.resetsAt.get(window.window), now);
        if (phrase === undefined) return [];
        const lower = `${phrase.charAt(0).toLowerCase()}${phrase.slice(1)}`;
        return [reading.windows.length > 1 ? `${window.short} ${lower}` : phrase];
      });
      return [{ name, reading, resets: resets.length === 0 ? undefined : resets.join(" · ") }];
    });
  }, [instances, now, snapshot]);
}

export function InboxPlanUsageRows(props: { readonly usage: ReadonlyArray<InboxPlanUsageEntry> }) {
  return (
    <ul className="surface-list">
      {props.usage.map(({ name, reading, resets }) => (
        <li className="surface-row inbox-row inbox-row--static" key={reading.providerInstanceId}>
          <span className="inbox-usage">
            <span className="surface-row__copy">
              <span className="oct-row-label">{name}</span>
              {resets === undefined ? null : <span className="oct-meta">{resets}</span>}
            </span>
            <PlanUsageMeters windows={reading.windows} />
          </span>
        </li>
      ))}
    </ul>
  );
}
