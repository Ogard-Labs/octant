import { useMemo } from "react";
import { usePlanUsageClient } from "./PlanUsageContext";
import { PlanUsageMeters } from "./PlanUsageMeters";
import { railUsageReadings } from "./railUsageReading";
import { useProviderUsageSnapshot } from "./useProviderUsageSnapshot";

/**
 * The plan meters for the provider a new thread will send to, read from the
 * same host observation as the rail's rings. Nothing renders while the host
 * has no window for that provider (an API key, a runtime that does not report,
 * a window whose reset has passed), or before a provider is chosen.
 */
export function ComposerPlanUsage(props: { readonly providerInstanceId: string | undefined }) {
  const { snapshot, now } = useProviderUsageSnapshot(usePlanUsageClient());
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
  return reading === undefined ? null : <PlanUsageMeters windows={reading.windows} />;
}
