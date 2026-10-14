import type { ReactNode } from "react";
import { vi } from "vitest";
import {
  ComposerContextMeterGate,
  ComposerContextMeterProvider,
} from "./composerContextMeterScope";
import { compactionStateFixture, contextFixture } from "./contextFixtures";
import type { SessionCompactionController } from "./useSessionCompaction";

/**
 * Puts a composer in the active pane of a thread the host reports as being
 * compacted, the way the shell wraps a thread's surface.
 */
export function CompactingThread(props: { readonly children: ReactNode }) {
  const subject = contextFixture().subject;
  const executor = {
    kind: "runtime",
    driverKind: "codex",
    providerInstanceId: contextFixture().modelLimits.providerInstanceId,
  } as const;
  const controller: SessionCompactionController = {
    state: compactionStateFixture(subject, {
      compaction: { status: "refused", reason: "compaction-running" },
      latestCompaction: {
        status: "running",
        compactionId: "60000000-0000-4000-8000-000000000001",
        executor,
        requestedAt: "2026-07-18T20:00:00.000Z",
      },
    }),
    starting: false,
    stateUnknown: false,
    compact: vi.fn(async () => undefined),
  };
  return (
    <ComposerContextMeterProvider
      compaction={{ controller, names: { provider: () => undefined, model: () => undefined } }}
      status="not-planned"
      subjectKey="compacting-thread"
    >
      <ComposerContextMeterGate enabled>{props.children}</ComposerContextMeterGate>
    </ComposerContextMeterProvider>
  );
}
