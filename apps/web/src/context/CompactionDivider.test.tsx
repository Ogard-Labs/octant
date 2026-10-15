import { decodeContextCompactionReceipt } from "@octant/contracts/context";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TranscriptWindow } from "../transcript/TranscriptWindow";
import { placeCompactions } from "./CompactionDivider";
import {
  ComposerContextMeterGate,
  ComposerContextMeterProvider,
} from "./composerContextMeterScope";
import { compactionStateFixture, contextFixture } from "./contextFixtures";
import type { SessionCompactionController } from "./useSessionCompaction";

const subject = contextFixture().subject;

function receipt(options: {
  readonly id: string;
  readonly trigger: "requested" | "automatic";
  readonly completedAt: string;
}) {
  return decodeContextCompactionReceipt({
    compactionId: options.id,
    subject,
    executor: {
      kind: "runtime",
      driverKind: "codex",
      providerInstanceId: contextFixture().modelLimits.providerInstanceId,
    },
    trigger: options.trigger,
    tokensBefore: { kind: "known", tokens: 52_000, accuracy: "provider-reported" },
    tokensAfter: { kind: "known", tokens: 10_800, accuracy: "provider-reported" },
    tokensFreed: { kind: "measured", tokens: 41_200, accuracy: "provider-reported" },
    summary: { visibility: "runtime-only" },
    usage: { kind: "unreported" },
    completedAt: options.completedAt,
  });
}

const manual = receipt({
  id: "60000000-0000-4000-8000-000000000001",
  trigger: "requested",
  completedAt: "2026-07-18T10:30:00.000Z",
});
const automatic = receipt({
  id: "60000000-0000-4000-8000-000000000002",
  trigger: "automatic",
  completedAt: "2026-07-18T11:30:00.000Z",
});

interface Row {
  readonly id: string;
  readonly at?: string;
}

const rows: ReadonlyArray<Row> = [
  { id: "a", at: "2026-07-18T10:00:00.000Z" },
  { id: "b", at: "2026-07-18T11:00:00.000Z" },
  { id: "c", at: "2026-07-18T12:00:00.000Z" },
];

function rowAt(row: Row): string | undefined {
  return row.at;
}

describe("placeCompactions", () => {
  it("puts each compaction before the first row that ended after it", () => {
    const placed = placeCompactions(rows, [manual, automatic], rowAt);
    expect([...placed.before.keys()]).toEqual([1, 2]);
    expect(placed.trailing).toEqual([]);
  });

  it("leaves out a compaction that predates the loaded rows and trails one after them", () => {
    const early = receipt({
      id: "60000000-0000-4000-8000-000000000003",
      trigger: "requested",
      completedAt: "2026-07-18T09:00:00.000Z",
    });
    const late = receipt({
      id: "60000000-0000-4000-8000-000000000004",
      trigger: "requested",
      completedAt: "2026-07-18T13:00:00.000Z",
    });
    const placed = placeCompactions(rows, [early, late], rowAt);
    expect(placed.before.size).toBe(0);
    expect(placed.trailing).toEqual([late]);
  });

  it("gives a row without a time the time of the row before it", () => {
    const placed = placeCompactions(
      [
        { id: "a", at: "2026-07-18T10:00:00.000Z" },
        { id: "reply" },
        { id: "c", at: "2026-07-18T12:00:00.000Z" },
      ],
      [automatic],
      rowAt,
    );
    expect([...placed.before.keys()]).toEqual([2]);
  });
});

describe("compaction divider in a transcript", () => {
  function renderTranscript(completed: ReturnType<typeof receipt>[], active = true) {
    const controller: SessionCompactionController = {
      state: compactionStateFixture(subject, { completedCompactions: completed }),
      starting: false,
      stateUnknown: false,
      compact: vi.fn(async () => undefined),
    };
    return render(
      <ComposerContextMeterProvider
        compaction={{ controller, names: { provider: () => "Codex", model: () => undefined } }}
        status="not-planned"
      >
        <ComposerContextMeterGate enabled={active}>
          <TranscriptWindow
            itemAt={rowAt}
            itemKey={(row) => row.id}
            items={rows}
            listLabel="Transcript"
            renderItem={(row) => <p>{`Row ${row.id}`}</p>}
            restoreKey="thread-a"
          />
        </ComposerContextMeterGate>
      </ComposerContextMeterProvider>,
    );
  }

  it("marks a requested and an automatic compaction where they happened", () => {
    renderTranscript([manual, automatic]);

    const dividers = screen.getAllByRole("separator");
    expect(dividers.map((divider) => divider.textContent)).toEqual([
      "Compacted · 41.2K freed · summary by Codex",
      "Compacted automatically by Codex · 41.2K freed",
    ]);
    const [first] = dividers;
    if (first === undefined) throw new Error("The requested compaction has a divider");
    // The divider sits above row b, the first row that ended after it.
    expect(first.compareDocumentPosition(screen.getByText("Row b"))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("shows no divider in a pane that is not the active thread's", () => {
    renderTranscript([manual, automatic], false);
    expect(screen.queryAllByRole("separator")).toEqual([]);
  });

  it("shows no divider for a thread that was never compacted", () => {
    renderTranscript([]);
    expect(screen.queryAllByRole("separator")).toEqual([]);
  });
});
