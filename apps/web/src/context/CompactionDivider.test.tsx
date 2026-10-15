import type { ContextClient } from "@octant/client-runtime/context-client";
import {
  decodeContextCompactionReceipt,
  decodeContextSubjectRef,
  type ContextSubjectRef,
} from "@octant/contracts/context";
import { render, screen, waitFor, within } from "@testing-library/react";
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
  const otherSubject = decodeContextSubjectRef({
    aggregateType: "code-thread",
    aggregateId: "70000000-0000-4000-8000-000000000009",
  });
  const otherReceipt = decodeContextCompactionReceipt({
    ...manual,
    compactionId: "60000000-0000-4000-8000-000000000009",
    subject: otherSubject,
    trigger: "automatic",
  });

  function clientFor(byThread: ReadonlyMap<string, ReturnType<typeof receipt>[]>): ContextClient {
    return {
      readCompaction: vi.fn(async (asked: ContextSubjectRef) =>
        compactionStateFixture(asked, {
          completedCompactions: byThread.get(String(asked.aggregateId)) ?? [],
        }),
      ),
    } as unknown as ContextClient;
  }

  function pane(thread: ContextSubjectRef, label: string) {
    return (
      <section aria-label={label}>
        <TranscriptWindow
          compactionSubject={thread}
          itemAt={rowAt}
          itemKey={(row) => row.id}
          items={rows}
          listLabel={label}
          renderItem={(row) => <p>{`Row ${row.id}`}</p>}
          restoreKey={label}
        />
      </section>
    );
  }

  function renderPanes(client: ContextClient, activeEnabled = true) {
    // The shell's controller answers for the active pane's thread only.
    const controller: SessionCompactionController = {
      state: compactionStateFixture(subject, { completedCompactions: [manual] }),
      starting: false,
      stateUnknown: false,
      compact: vi.fn(async () => undefined),
    };
    return render(
      <ComposerContextMeterProvider
        compaction={{
          controller,
          client,
          names: { provider: () => "Codex", model: () => undefined },
        }}
        status="not-planned"
      >
        <ComposerContextMeterGate enabled={activeEnabled}>
          {pane(subject, "Active pane")}
        </ComposerContextMeterGate>
        <ComposerContextMeterGate enabled={false}>
          {pane(otherSubject, "Background pane")}
        </ComposerContextMeterGate>
      </ComposerContextMeterProvider>,
    );
  }

  it("marks a requested and an automatic compaction where they happened", async () => {
    renderPanes(clientFor(new Map([[String(subject.aggregateId), [manual, automatic]]])));

    const pane = within(screen.getByRole("region", { name: "Active pane" }));
    const dividers = await pane.findAllByRole("separator");
    expect(dividers.map((divider) => divider.textContent)).toEqual([
      "Compacted · 41.2K freed · summary by Codex",
      "Compacted automatically by Codex · 41.2K freed",
    ]);
    const [first] = dividers;
    if (first === undefined) throw new Error("The requested compaction has a divider");
    // The divider sits above row b, the first row that ended after it.
    expect(first.compareDocumentPosition(pane.getByText("Row b"))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("shows each pane the compactions of its own thread, active or not", async () => {
    renderPanes(
      clientFor(
        new Map([
          [String(subject.aggregateId), [manual]],
          [String(otherSubject.aggregateId), [otherReceipt]],
        ]),
      ),
    );

    const active = within(screen.getByRole("region", { name: "Active pane" }));
    const background = within(screen.getByRole("region", { name: "Background pane" }));
    expect((await active.findAllByRole("separator")).map((d) => d.textContent)).toEqual([
      "Compacted · 41.2K freed · summary by Codex",
    ]);
    expect((await background.findAllByRole("separator")).map((d) => d.textContent)).toEqual([
      "Compacted automatically by Codex · 41.2K freed",
    ]);
  });

  it("shows a pane no divider when only another thread was compacted", async () => {
    const client = clientFor(new Map([[String(subject.aggregateId), [manual]]]));
    renderPanes(client);

    const active = within(screen.getByRole("region", { name: "Active pane" }));
    await active.findAllByRole("separator");
    const background = within(screen.getByRole("region", { name: "Background pane" }));
    expect(background.queryAllByRole("separator")).toEqual([]);
  });

  it("shows a compaction journaled in a turn that was already listed", async () => {
    const byThread = new Map<string, ReturnType<typeof receipt>[]>();
    const client = clientFor(byThread);
    const view = (items: ReadonlyArray<Row>) => (
      <ComposerContextMeterProvider
        compaction={{
          controller: {
            starting: false,
            stateUnknown: false,
            compact: vi.fn(async () => undefined),
          },
          client,
          names: { provider: () => "Codex", model: () => undefined },
        }}
        status="not-planned"
      >
        <TranscriptWindow
          compactionSubject={otherSubject}
          itemAt={rowAt}
          itemKey={(row) => row.id}
          items={items}
          listLabel="Background"
          renderItem={(row) => <p>{`Row ${row.id}`}</p>}
          restoreKey="background"
        />
      </ComposerContextMeterProvider>
    );
    const view1 = render(view(rows));
    await waitFor(() => expect(client.readCompaction).toHaveBeenCalledTimes(1));
    expect(screen.queryAllByRole("separator")).toEqual([]);

    // The turn keeps its place and its count; only its time moves on.
    byThread.set(String(otherSubject.aggregateId), [otherReceipt]);
    view1.rerender(
      view(rows.map((row) => (row.id === "c" ? { ...row, at: "2026-07-18T12:45:00.000Z" } : row))),
    );

    expect(await screen.findAllByRole("separator")).toHaveLength(1);
  });

  it("shows no divider for a thread that was never compacted", async () => {
    const client = clientFor(new Map());
    renderPanes(client);
    await waitFor(() => expect(client.readCompaction).toHaveBeenCalledTimes(2));
    expect(screen.queryAllByRole("separator")).toEqual([]);
  });
});
