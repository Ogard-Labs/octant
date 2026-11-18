import { useMemo } from "react";
import { usePlanUsageReading } from "./PlanUsageContext";
import { PlanUsageLine } from "./PlanUsageLine";
import { railUsageReadings } from "./railUsageReading";

/**
 * The plan usage line for the provider a new thread will send to, read from the
 * same host observation as the rail's rings. Every observed window shows, with what is left and when it resets. Nothing renders while the host
 * has no window for that provider (an API key, a runtime that does not report,
 * a window whose reset has passed), or before a provider is chosen.
 */
export function ComposerPlanUsage(props: { readonly providerInstanceId: string | undefined }) {
  const { snapshot, now } = usePlanUsageReading();
  const { providerInstanceId } = props;
  const reading = useMemo(
    () =>
      snapshot === undefined || providerInstanceId === undefined
        ? undefined
        : railUsageReadings(
            snapshot.entries.filter(
              (entry) => String(entry.providerInstanceId) === providerInstanceId,
            ),
            now,
          )[0],
    [now, providerInstanceId, snapshot],
  );
  return reading === undefined ? null : (
    <PlanUsageLine now={now} resetsAt={reading.resetsAt} windows={reading.windows} />
  );
}
