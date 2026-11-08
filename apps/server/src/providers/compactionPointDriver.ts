import type { ProviderModelId } from "@octant/contracts";
import type { ProviderCompactionPoint, ProviderDriver } from "@octant/provider-sdk/driver";
import { Effect } from "effect";

/**
 * Hands every session a driver opens the compaction point the person set in
 * Settings, read when the session starts or resumes, so a change applies from
 * the next one. A session the host sends one request (a summary, a draft) is
 * left alone: it never fills a window. A session that already names a point
 * keeps it. Whether the runtime honours the point is its driver's
 * `compactionPoint` capability; this only says what the person asked for.
 */
export function withCompactionPoint(
  driver: ProviderDriver,
  point: (modelId: ProviderModelId) => ProviderCompactionPoint | undefined,
): ProviderDriver {
  const pointFor = (modelId: ProviderModelId | undefined) => {
    if (modelId === undefined) return {};
    const chosen = point(modelId);
    return chosen === undefined ? {} : { compactionPoint: chosen };
  };
  return {
    ...driver,
    acquire: (input) =>
      driver.acquire(input).pipe(
        Effect.map((connection) => ({
          ...connection,
          start: (start) =>
            connection.start(
              start.singleUse === true || start.compactionPoint !== undefined
                ? start
                : { ...start, ...pointFor(start.modelId) },
            ),
          resume: (resume) =>
            connection.resume(
              resume.compactionPoint !== undefined
                ? resume
                : { ...resume, ...pointFor(resume.modelId) },
            ),
        })),
      ),
  };
}

/** The point a share of a model's window names, or none for a window nobody reported. */
export function compactionPointFor(
  sharePercent: number | null,
  contextWindow: number | undefined,
): ProviderCompactionPoint | undefined {
  if (sharePercent === null || contextWindow === undefined || contextWindow <= 0) return undefined;
  return { tokens: Math.floor((contextWindow * sharePercent) / 100), contextWindow };
}
