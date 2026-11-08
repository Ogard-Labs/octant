import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { TurnDiagnosticsReport, TurnMetricsRecord } from "@octant/contracts";
import { BenchmarksClientError, type BenchmarksClient } from "@octant/client-runtime";
import { buildTurnDiagnosticsReport } from "@octant/domain";
import { UsageWorkspace } from "../UsageWorkspace";
import { BENCHMARK_POLL_MS, BenchmarksWorkspace } from "./BenchmarksWorkspace";
import { exportSuiteJson } from "./benchmarkPresentation";
import {
  CASE_ONE,
  NOW,
  PROVIDER,
  RUN_ID,
  SUITE_ID,
  THREAD_DEEP,
  THREAD_FAST,
  TURN_DEEP,
  TURN_FAST,
  providerSnapshot,
  readResponse,
  run,
  suite,
  summary,
} from "./benchmarksFixtures";

function makeClient(overrides: Partial<BenchmarksClient> = {}) {
  const base = {
    listSuites: vi.fn(async () => ({ suites: [suite()] })),
    saveSuite: vi.fn(async (request: Parameters<BenchmarksClient["saveSuite"]>[0]) => ({
      suite: suite({
        suiteId: request.suiteId,
        name: request.name,
        cases: request.cases,
        revision: 1,
      }),
    })),
    deleteSuite: vi.fn(async () => ({ suiteId: suite().suiteId })),
    listRuns: vi.fn(async () => ({ runs: [summary("finished")] })),
    readRun: vi.fn(async () => readResponse("finished")),
    startRun: vi.fn(async (_request: Parameters<BenchmarksClient["startRun"]>[0]) => ({
      run: run(),
    })),
    cancelRun: vi.fn(async () => ({ run: run("cancelled") })),
    purgeRun: vi.fn(async () => ({ runId: run().runId })),
  } satisfies BenchmarksClient;
  // Overrides replace calls the test asserts on; the mock handles stay typed.
  return { ...base, ...overrides } as typeof base;
}

function mount(
  client: BenchmarksClient,
  props: Partial<Parameters<typeof BenchmarksWorkspace>[0]> = {},
) {
  return render(
    <BenchmarksWorkspace
      client={client}
      pollIntervalMs={20}
      providerSnapshot={providerSnapshot()}
      {...props}
    />,
  );
}

const user = () => userEvent.setup();

async function openSuite(actor: ReturnType<typeof user>) {
  await actor.click(await screen.findByRole("button", { name: "Capital cities" }));
}

async function openRun(actor: ReturnType<typeof user>) {
  await openSuite(actor);
  const table = await screen.findByRole("table", { name: "Runs of this suite" });
  await actor.click(within(table).getAllByRole("button")[0] as HTMLElement);
  await screen.findByRole("region", { name: "Live grid" });
}

function pricedReport(): TurnDiagnosticsReport {
  const record = {
    threadId: THREAD_FAST,
    mode: "chat",
    providerInstanceId: PROVIDER,
    modelId: "model-fast",
    stopReason: "end-of-turn",
    usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.1 },
    metrics: {
      precision: "exact",
      wallMs: 1_000,
      timeToFirstTokenMs: 200,
      decodeOutputTokens: 50,
      decodeMs: 500,
      toolMs: 0,
      modelCalls: 1,
    },
    diagnostics: { toolCalls: 0, toolFailures: 0 },
    startedAt: "2026-11-07T10:00:00.000Z",
    endedAt: "2026-11-07T10:00:01.000Z",
  } as TurnMetricsRecord;
  return buildTurnDiagnosticsReport([record, record], {
    generatedAt: NOW,
    bucket: "day",
    timeZone: "UTC",
  });
}

describe("the Benchmarks source of Usage", () => {
  it("offers Benchmarks beside Diagnostics when the host can run them", async () => {
    const actor = user();
    render(
      <UsageWorkspace
        benchmarksClient={makeClient()}
        client={{ load: vi.fn(() => new Promise<never>(() => undefined)) } as never}
        diagnosticsClient={{ diagnostics: vi.fn(async () => pricedReport()) }}
      />,
    );

    expect(screen.getByRole("button", { name: "Diagnostics" })).toBeInTheDocument();
    await actor.click(screen.getByRole("button", { name: "Benchmarks" }));

    expect(await screen.findByRole("heading", { name: "Benchmarks" })).toBeInTheDocument();
    expect(await screen.findByRole("table", { name: "Suites" })).toBeInTheDocument();
  });

  it("lists each suite with its case count and last run", async () => {
    mount(makeClient());

    const table = await screen.findByRole("table", { name: "Suites" });
    const row = within(table).getByRole("row", { name: /Capital cities/ });
    expect(within(row).getByText("2")).toBeInTheDocument();
    expect(within(row).getByText(/Finished/)).toBeInTheDocument();
  });
});

describe("the suite editor", () => {
  async function fillBasics(actor: ReturnType<typeof user>) {
    await actor.click(await screen.findByRole("button", { name: "New suite" }));
    await actor.type(screen.getByRole("textbox", { name: "Suite name" }), "Greetings");
    await actor.type(screen.getByRole("textbox", { name: "Title of case 1" }), "Say hello");
    await actor.type(screen.getByRole("textbox", { name: "Prompt of case 1" }), "Say hello.");
    await actor.click(screen.getByRole("button", { name: "Add check" }));
  }

  async function chooseKind(actor: ReturnType<typeof user>, option: string) {
    await actor.click(screen.getByRole("combobox", { name: "Kind of check 1 of case 1" }));
    await actor.click(await screen.findByRole("option", { name: option }));
  }

  it("saves a valid suite as a new suite", async () => {
    const actor = user();
    const client = makeClient();
    mount(client);

    await fillBasics(actor);
    await actor.type(screen.getByRole("textbox", { name: "Text of check 1 of case 1" }), "hello");
    await actor.click(screen.getByRole("button", { name: "Save suite" }));

    await waitFor(() => expect(client.saveSuite).toHaveBeenCalledTimes(1));
    const [request] = client.saveSuite.mock.calls[0] ?? [];
    expect(request).toMatchObject({
      name: "Greetings",
      cases: [
        {
          kind: "prompt",
          title: "Say hello",
          checks: [{ kind: "contains", text: "hello", caseSensitive: false }],
        },
      ],
    });
    expect(request).not.toHaveProperty("expectedRevision");
    expect(await screen.findByText('Saved "Greetings".')).toBeInTheDocument();
  });

  it("names the revision when it edits a saved suite", async () => {
    const actor = user();
    const client = makeClient();
    mount(client);

    await actor.click(await screen.findByRole("button", { name: "Edit Capital cities" }));
    await actor.click(screen.getByRole("button", { name: "Save suite" }));

    await waitFor(() => expect(client.saveSuite).toHaveBeenCalledTimes(1));
    expect(client.saveSuite.mock.calls[0]?.[0]).toMatchObject({
      suiteId: SUITE_ID,
      expectedRevision: 2,
    });
  });

  it("refuses a pattern that is not a regular expression, in a sentence", async () => {
    const actor = user();
    const client = makeClient();
    mount(client);

    await fillBasics(actor);
    await chooseKind(actor, "Matches pattern");
    await actor.type(screen.getByRole("textbox", { name: "Pattern of check 1 of case 1" }), "(");
    await actor.click(screen.getByRole("button", { name: "Save suite" }));

    expect(
      await screen.findByText(/has a pattern that is not a valid regular expression/),
    ).toBeVisible();
    expect(client.saveSuite).not.toHaveBeenCalled();
  });

  it("refuses a worktree check on a prompt case, in a sentence", async () => {
    const actor = user();
    const client = makeClient();
    mount(client);

    await fillBasics(actor);
    await chooseKind(actor, "Command exits with zero");
    await actor.type(
      screen.getByRole("textbox", { name: "Command of check 1 of case 1" }),
      "bun test",
    );
    await actor.click(screen.getByRole("button", { name: "Save suite" }));

    expect(await screen.findByText(/only a Code case can have it/)).toBeVisible();
    expect(client.saveSuite).not.toHaveBeenCalled();
  });

  it("says only this Mac's window can edit when the host refuses a write", async () => {
    const actor = user();
    const client = makeClient({
      saveSuite: vi.fn(async () => {
        throw new BenchmarksClientError("Forbidden", 403);
      }),
    });
    mount(client);

    await fillBasics(actor);
    await actor.type(screen.getByRole("textbox", { name: "Text of check 1 of case 1" }), "hello");
    await actor.click(screen.getByRole("button", { name: "Save suite" }));

    expect(await screen.findByText("Only this Mac's window can edit benchmarks.")).toBeVisible();
  });
});

describe("importing and exporting a suite as JSON", () => {
  it("opens a pasted suite in the editor as a new suite", async () => {
    const actor = user();
    mount(makeClient());

    await actor.click(await screen.findByRole("button", { name: "Import suite" }));
    await actor.click(screen.getByRole("textbox", { name: "Pasted suite JSON" }));
    await actor.paste(exportSuiteJson(suite()));
    await actor.click(screen.getByRole("button", { name: "Read pasted JSON" }));

    expect(await screen.findByRole("form", { name: "Suite editor" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Suite name" })).toHaveValue("Capital cities");
    expect(screen.getByRole("textbox", { name: "Title of case 2" })).toHaveValue(
      "Capital of Sweden",
    );
    expect(screen.getByRole("heading", { name: "New suite" })).toBeInTheDocument();
  });

  it("reads a chosen file through the same contract", async () => {
    const actor = user();
    mount(makeClient());

    await actor.click(await screen.findByRole("button", { name: "Import suite" }));
    await actor.upload(
      screen.getByLabelText("Suite file"),
      new File([exportSuiteJson(suite())], "suite.json", { type: "application/json" }),
    );

    expect(await screen.findByRole("form", { name: "Suite editor" })).toBeInTheDocument();
  });

  it("states what is wrong with a file that is not a suite", async () => {
    const actor = user();
    mount(makeClient());

    await actor.click(await screen.findByRole("button", { name: "Import suite" }));
    await actor.upload(
      screen.getByLabelText("Suite file"),
      new File(["not json at all"], "broken.json", { type: "application/json" }),
    );
    expect(
      await screen.findByText("This is not JSON, so it cannot be a benchmark suite."),
    ).toBeVisible();

    await actor.click(screen.getByRole("textbox", { name: "Pasted suite JSON" }));
    await actor.paste(JSON.stringify({ name: "No cases" }));
    await actor.click(screen.getByRole("button", { name: "Read pasted JSON" }));
    expect(await screen.findByText(/This is not a benchmark suite:/)).toBeVisible();
    expect(screen.queryByRole("form", { name: "Suite editor" })).toBeNull();
  });

  it("exports a suite as a JSON file named for it", async () => {
    const actor = user();
    const saveFile = vi.fn();
    mount(makeClient(), { saveFile });

    await actor.click(await screen.findByRole("button", { name: "Export Capital cities as JSON" }));

    expect(saveFile).toHaveBeenCalledWith("capital-cities.json", expect.stringContaining(SUITE_ID));
  });
});

describe("the run builder", () => {
  it("estimates the cost from each model's earlier turns and starts with the chosen contenders", async () => {
    const actor = user();
    const client = makeClient();
    mount(client, { diagnosticsClient: { diagnostics: vi.fn(async () => pricedReport()) } });

    await openSuite(actor);
    const contenders = await screen.findByRole("group", { name: "Contenders" });
    // No history for this model, so nothing can price the run yet.
    await actor.click(
      within(contenders).getByRole("checkbox", { name: "Provider A · Deep model" }),
    );
    expect(await screen.findByText(/No estimate yet/)).toBeInTheDocument();

    await actor.click(
      within(contenders).getByRole("checkbox", { name: "Provider A · Fast model" }),
    );
    await actor.click(screen.getByRole("button", { name: "Increase Repetitions" }));
    expect(
      await screen.findByText(
        /Estimated cost \$0\.4000 for 8 cells, not counting Provider A · Deep model/,
      ),
    ).toBeInTheDocument();

    await actor.click(
      within(contenders).getByRole("checkbox", { name: "Provider A · Deep model" }),
    );
    await actor.type(screen.getByRole("textbox", { name: "Cost budget in US dollars" }), "1");
    expect(await screen.findByText(/Estimated cost \$0\.4000 for 4 cells\./)).toBeInTheDocument();
    await actor.click(screen.getByRole("button", { name: "Start run" }));

    await waitFor(() => expect(client.startRun).toHaveBeenCalledTimes(1));
    expect(client.startRun.mock.calls[0]?.[0]).toMatchObject({
      suiteId: SUITE_ID,
      contenders: [{ providerInstanceId: PROVIDER, modelId: "model-fast" }],
      repetitions: 2,
      budget: { maxCostUsd: 1 },
    });
    expect(await screen.findByRole("region", { name: "Live grid" })).toBeInTheDocument();
  });

  it("holds Start back until a contender and a budget are chosen", async () => {
    const actor = user();
    mount(makeClient());

    await openSuite(actor);
    const start = await screen.findByRole("button", { name: "Start run" });
    expect(start).toBeDisabled();

    const contenders = screen.getByRole("group", { name: "Contenders" });
    await actor.click(
      within(contenders).getByRole("checkbox", { name: "Provider A · Fast model" }),
    );
    expect(screen.getByText("Set a token or cost budget.")).toBeInTheDocument();
    expect(start).toBeDisabled();
  });
});

describe("the live grid", () => {
  it("shows each cell's state as an icon with a word, with its time and tokens", async () => {
    const actor = user();
    mount(makeClient({ readRun: vi.fn(async () => readResponse("running")) }));

    await openRun(actor);

    const grid = await screen.findByRole("table", { name: "Cases by contender" });
    expect(within(grid).getAllByText("Answered")).toHaveLength(2);
    for (const word of ["Running", "Queued"]) {
      expect(within(grid).getByText(word)).toBeInTheDocument();
    }
    expect(within(grid).getByText("2.0 s · 600 tokens")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel run" })).toBeInTheDocument();
  });

  it("polls while the run runs, and stops once it ends", async () => {
    expect(BENCHMARK_POLL_MS).toBe(3_000);
    const actor = user();
    let reads = 0;
    const readRun = vi.fn(async () => readResponse(++reads >= 4 ? "finished" : "running"));
    mount(makeClient({ readRun }));

    await openRun(actor);
    await waitFor(() => expect(readRun.mock.calls.length).toBeGreaterThanOrEqual(4));
    expect(await screen.findByText(/Finished · 4 of 4 cells settled/)).toBeInTheDocument();
    expect(screen.getByText("Every cell settled.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel run" })).toBeNull();

    const settledReads = readRun.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(readRun.mock.calls.length).toBe(settledReads);
  });

  it("stops polling when the view goes away", async () => {
    const actor = user();
    const readRun = vi.fn(async () => readResponse("running"));
    const { unmount } = mount(makeClient({ readRun }));

    await openRun(actor);
    await waitFor(() => expect(readRun.mock.calls.length).toBeGreaterThanOrEqual(3));
    unmount();

    const readsAtUnmount = readRun.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(readRun.mock.calls.length).toBe(readsAtUnmount);
  });

  it("cancels a running run", async () => {
    const actor = user();
    const client = makeClient({ readRun: vi.fn(async () => readResponse("running")) });
    mount(client);

    await openRun(actor);
    await actor.click(screen.getByRole("button", { name: "Cancel run" }));

    await waitFor(() => expect(client.cancelRun).toHaveBeenCalledWith({ runId: RUN_ID }));
  });
});

describe("the leaderboard", () => {
  async function leaderboard(actor: ReturnType<typeof user>) {
    mount(makeClient());
    await openRun(actor);
    return screen.findByRole("table", { name: "Leaderboard" });
  }
  const order = (table: HTMLElement) =>
    within(table)
      .getAllByRole("row")
      .slice(1)
      .map((row) => (/Fast model/.test(row.textContent ?? "") ? "fast" : "deep"));

  it("heads the table with the best pass rate, the fastest first token, and the cheapest", async () => {
    const actor = user();
    await leaderboard(actor);

    const headline = screen.getByRole("list", { name: "Headline" });
    expect(within(headline).getByText("Best pass rate")).toBeInTheDocument();
    expect(within(headline).getByText("Fastest first token")).toBeInTheDocument();
    expect(within(headline).getByText("Cheapest")).toBeInTheDocument();
    expect(within(headline).getAllByText("Provider A · Fast model")).toHaveLength(3);
  });

  it("sorts by any column, with a missing figure always last", async () => {
    const actor = user();
    const table = await leaderboard(actor);
    expect(order(table)).toEqual(["fast", "deep"]);

    await actor.click(within(table).getByRole("button", { name: "Check pass rate" }));
    expect(order(table)).toEqual(["deep", "fast"]);

    // The slower contender has no cost figure, so it stays last either way.
    await actor.click(within(table).getByRole("button", { name: "Cost" }));
    expect(order(table)).toEqual(["fast", "deep"]);
    await actor.click(within(table).getByRole("button", { name: "Cost" }));
    expect(order(table)).toEqual(["fast", "deep"]);

    await actor.click(within(table).getByRole("button", { name: "First token, typical" }));
    expect(order(table)).toEqual(["fast", "deep"]);
    await actor.click(within(table).getByRole("button", { name: "First token, typical" }));
    expect(order(table)).toEqual(["deep", "fast"]);
  });

  it("reads a score no one gave as a dash", async () => {
    const actor = user();
    const table = await leaderboard(actor);

    const deep = within(table).getByRole("row", { name: /Deep model/ });
    const cells = within(deep).getAllByRole("cell");
    // Judge score, stars, and cost: nothing measured, so none shown as zero.
    expect(cells[0]).toHaveTextContent("0%");
    expect(cells[1]).toHaveTextContent("—");
    expect(cells[2]).toHaveTextContent("—");
    expect(cells[8]).toHaveTextContent("—");
  });

  it("opens a contender's cells from its row", async () => {
    const actor = user();
    const table = await leaderboard(actor);

    await actor.click(within(table).getByRole("button", { name: "Provider A · Deep model" }));

    const cells = await screen.findByRole("region", { name: "Cells of Provider A · Deep model" });
    expect(within(cells).getByText("Failed")).toBeInTheDocument();
    expect(within(cells).getByText("0 of 1")).toBeInTheDocument();
  });
});

describe("case compare", () => {
  function view(body: string, turnId: string) {
    return {
      turns: [
        {
          id: turnId,
          attempts: [{ outcome: "completed", responseRefs: [{ contentId: `content-${turnId}` }] }],
        },
      ],
      contents: [{ contentId: `content-${turnId}`, role: "assistant", body }],
    };
  }

  it("reads each contender's answer from its own thread, beside its figures and scores", async () => {
    const actor = user();
    const onOpenSubject = vi.fn();
    const thread = vi.fn(async (threadId: string) =>
      threadId === THREAD_FAST
        ? (view("Oslo.", TURN_FAST) as never)
        : (view("Bergen, I think.", TURN_DEEP) as never),
    );
    mount(makeClient(), { chatClient: { thread }, onOpenSubject });

    await openRun(actor);

    const fast = await screen.findByRole("region", {
      name: "Answers from Provider A · Fast model",
    });
    const deep = screen.getByRole("region", { name: "Answers from Provider A · Deep model" });
    expect(await within(fast).findByLabelText("Answer")).toHaveTextContent("Oslo.");
    expect(await within(deep).findByLabelText("Answer")).toHaveTextContent("Bergen, I think.");
    expect(thread).toHaveBeenCalledWith(THREAD_FAST);
    expect(thread).toHaveBeenCalledWith(THREAD_DEEP);

    expect(within(fast).getByText("Passed: Contains text")).toBeInTheDocument();
    expect(within(fast).getByText("Judge: 9 of 10. Correct and brief.")).toBeInTheDocument();
    expect(
      within(deep).getByText("Failed: Contains text. Oslo was not in the answer."),
    ).toBeInTheDocument();
    expect(within(deep).getByText("5.0 s")).toBeInTheDocument();

    await actor.click(within(fast).getByRole("button", { name: "Open thread" }));
    expect(onOpenSubject).toHaveBeenCalledWith("chat-thread", THREAD_FAST);
  });

  it("switches to another case without copying any answer into the run", async () => {
    const actor = user();
    const thread = vi.fn(async () => view("Stockholm.", TURN_FAST) as never);
    mount(makeClient(), { chatClient: { thread } });

    await openRun(actor);
    await screen.findByRole("region", { name: "Case compare" });
    await actor.click(screen.getByRole("combobox", { name: "Case to compare" }));
    await actor.click(await screen.findByRole("option", { name: "Capital of Sweden" }));

    const fast = await screen.findByRole("region", {
      name: "Answers from Provider A · Fast model",
    });
    expect(await within(fast).findByLabelText("Answer")).toHaveTextContent("Stockholm.");
    expect(JSON.stringify(readResponse("finished"))).not.toContain("Stockholm");
  });

  it("says so when a thread can no longer be read", async () => {
    const actor = user();
    const thread = vi.fn(async () => {
      throw new Error("gone");
    });
    mount(makeClient(), { chatClient: { thread } });

    await openRun(actor);

    expect(
      (await screen.findAllByText("The thread could not be read. It may be purged.")).length,
    ).toBeGreaterThan(0);
    expect(CASE_ONE).toBeTruthy();
  });
});

describe("the runs list", () => {
  it("purges a run only after a confirmation that says its threads are erased", async () => {
    const actor = user();
    const client = makeClient();
    mount(client);

    await openSuite(actor);
    await actor.click(await screen.findByRole("button", { name: /Purge the run from/ }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/erases the run's threads/)).toBeInTheDocument();
    await actor.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(client.purgeRun).not.toHaveBeenCalled();

    await actor.click(await screen.findByRole("button", { name: /Purge the run from/ }));
    await actor.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Purge run" }),
    );

    await waitFor(() => expect(client.purgeRun).toHaveBeenCalledWith({ runId: RUN_ID }));
    expect(await screen.findByText("Purged the run and its threads.")).toBeInTheDocument();
  });

  it("says only this Mac's window can purge when the host refuses", async () => {
    const actor = user();
    const client = makeClient({
      purgeRun: vi.fn(async () => {
        throw new BenchmarksClientError("Forbidden", 403);
      }),
    });
    mount(client);

    await openSuite(actor);
    await actor.click(await screen.findByRole("button", { name: /Purge the run from/ }));
    await actor.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Purge run" }),
    );

    expect(await screen.findByText("Only this Mac's window can edit benchmarks.")).toBeVisible();
  });
});
