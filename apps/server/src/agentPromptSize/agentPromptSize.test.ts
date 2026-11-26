import { describe, expect, it } from "vitest";
import {
  CANVAS_DELIVERY_INSTRUCTIONS,
  nativeArtifactDeliveryInstructions,
} from "../canvas/canvasDeliveryInstructions";
import { WindowsTerminalShell } from "@octant/contracts";
import { windowsShellInstruction } from "../harness/nativeHarnessInstructions";
import { nativeHarnessToolDefinitionsFor } from "../harness/nativeHarnessTools";
import { appToolHostLines } from "../providers/appToolHostLines";
import { firstPartyToolNames } from "../providers/firstPartyToolNames.test-support";
import {
  AGENT_PROMPT_CONTEXTS,
  AGENT_PROMPT_RUNTIMES,
  budgetFor,
  measureAgentPrompts,
  NOT_MEASURED_TOOLS,
  overBudget,
  promptInstructionTexts,
  promptTools,
  readAgentPromptBudget,
  underBudget,
} from "./agentPromptSize";

describe("agent prompt size", () => {
  it("reports each runtime's instruction and tool sizes", () => {
    const report = measureAgentPrompts();
    expect(Object.keys(report)).toEqual([...AGENT_PROMPT_RUNTIMES]);
    for (const runtime of AGENT_PROMPT_RUNTIMES) {
      expect(Object.keys(report[runtime])).toEqual([...AGENT_PROMPT_CONTEXTS]);
      for (const context of AGENT_PROMPT_CONTEXTS) {
        const size = report[runtime][context];
        expect(size.firstPrompt.instructionBytes).toBeGreaterThan(0);
        expect(size.firstPrompt.toolBytes).toBeGreaterThan(0);
        expect(size.firstPrompt.estimatedTokens).toBe(
          Math.ceil((size.firstPrompt.instructionBytes + size.firstPrompt.toolBytes) / 4),
        );
      }
      // Work carries its own tools beside the ones Chat has.
      expect(report[runtime].work.firstPrompt.toolBytes).toBeGreaterThan(
        report[runtime].chat.firstPrompt.toolBytes,
      );
    }
  });

  it("counts again only what a runtime is sent again on a later turn", () => {
    const report = measureAgentPrompts();
    // A session that keeps its history and its tool list is sent neither twice.
    for (const runtime of ["claude", "codex", "opencode", "pi"] as const)
      expect(report[runtime].code.laterTurn).toMatchObject({ instructionBytes: 0, toolBytes: 0 });
    // An ACP agent never says it kept a prompt, so it is told again.
    expect(report.acp.code.laterTurn.instructionBytes).toBe(
      report.acp.code.firstPrompt.instructionBytes,
    );
    expect(report.acp.code.laterTurn.toolBytes).toBe(0);
    // An endpoint holds nothing between requests.
    expect(report.harness.code.laterTurn).toEqual(report.harness.code.firstPrompt);
  });

  it("measures Claude's artifact delivery rule where a Work or Code turn can carry it", () => {
    const artifactRule = nativeArtifactDeliveryInstructions({
      toolName: "Artifact",
      canvasOffered: true,
    });
    // Claude alone names an artifact tool, and only for a Work or Code lead.
    for (const context of ["work", "code"] as const) {
      expect(promptInstructionTexts("claude", context)).toContain(artifactRule);
      expect(promptInstructionTexts("codex", context)).toContain(CANVAS_DELIVERY_INSTRUCTIONS);
    }
    expect(promptInstructionTexts("claude", "chat")).toContain(CANVAS_DELIVERY_INSTRUCTIONS);
  });

  it("measures the widest form of a tool whose definition depends on the turn", () => {
    const schemaOf = (context: "chat" | "work" | "code", name: string) =>
      JSON.stringify(promptTools(context).find((tool) => tool.name === name));
    // A Code thread with linked issues may update them.
    expect(schemaOf("code", "octant_github")).toContain('"close"');
    expect(schemaOf("code", "octant_linear")).toContain('"set-state"');
    // A Code thread on its Project's shared checkout may ask to move off it.
    expect(schemaOf("code", "octant_threads")).toContain('"move-to-worktree"');
    // A ready video model is described in the tool.
    expect(schemaOf("work", "octant_create_video")).toContain("gemini-omni-1.2-flash");
    // A Zen space's assistant is a Chat thread carrying its own tool too.
    expect(schemaOf("chat", "octant_zen")).not.toBe(undefined);
  });

  it("measures the longest Windows shell paragraph a Harness Work or Code turn can carry", () => {
    const paragraphs = WindowsTerminalShell.literals.map(windowsShellInstruction);
    const longest = paragraphs.reduce((a, b) => (b.length > a.length ? b : a));
    for (const context of ["work", "code"] as const)
      expect(promptInstructionTexts("harness", context)).toContain(longest);
    // Chat's harness has no shell.
    const chat = promptInstructionTexts("harness", "chat");
    expect(paragraphs.filter((paragraph) => chat.includes(paragraph))).toEqual([]);
  });

  it("measures every guided first-party tool, or says why a turn never carries it", () => {
    const measured = new Set(
      AGENT_PROMPT_CONTEXTS.flatMap((context) => promptTools(context).map((tool) => tool.name)),
    );
    const guided = firstPartyToolNames().filter((name) => appToolHostLines([{ name }]).length > 0);
    expect(guided.length).toBeGreaterThan(20);
    expect(guided.filter((name) => !measured.has(name) && !(name in NOT_MEASURED_TOOLS))).toEqual(
      [],
    );
  });

  it("measures the workspace tools a child run is really given", () => {
    const offered = { askUser: {}, filesystem: {}, webFetch: {}, webSearch: {} };
    for (const [context, mode, ports] of [
      ["chat-child", "chat", { askUser: {}, webFetch: {}, webSearch: {} }],
      ["work-child", "work", offered],
      ["code-child", "code", { ...offered, shell: {} }],
    ] as const) {
      const given = nativeHarnessToolDefinitionsFor(mode, ports as never).map((tool) => tool.name);
      expect(
        promptTools(context)
          .map((tool) => tool.name)
          .filter((name) => !name.startsWith("octant_")),
      ).toEqual(given);
    }
  });

  it("fails when a runtime grows past its budget", () => {
    const report = measureAgentPrompts();
    const exact = Object.fromEntries(
      AGENT_PROMPT_RUNTIMES.map((runtime) => [
        runtime,
        Object.fromEntries(
          AGENT_PROMPT_CONTEXTS.map((context) => {
            const size = report[runtime][context];
            return [
              context,
              {
                firstPromptBytes: size.firstPrompt.instructionBytes + size.firstPrompt.toolBytes,
                laterTurnBytes: size.laterTurn.instructionBytes + size.laterTurn.toolBytes,
              },
            ];
          }),
        ),
      ]),
    );
    const read = readAgentPromptBudget(exact);
    if (read.status === "refused") throw new Error(read.message);
    expect(overBudget(report, read.budget)).toEqual([]);
    expect(underBudget(report, read.budget)).toEqual([]);

    const tighter = structuredClone(exact);
    const codex = tighter["codex"]?.["code"];
    if (codex === undefined) throw new Error("Expected a Codex budget.");
    codex.firstPromptBytes -= 1;
    const readTighter = readAgentPromptBudget(tighter);
    if (readTighter.status === "refused") throw new Error(readTighter.message);
    expect(overBudget(report, readTighter.budget)).toEqual([
      {
        runtime: "codex",
        context: "code",
        measure: "firstPromptBytes",
        measured: codex.firstPromptBytes + 1,
        budget: codex.firstPromptBytes,
      },
    ]);
  });

  it("asks for a shrunk prompt to be recorded, so later growth cannot hide in the gap", () => {
    const report = measureAgentPrompts();
    const loose = structuredClone(budgetFor(report)) as {
      pi: { work: { laterTurnBytes: number } };
    };
    loose.pi.work.laterTurnBytes += 10;
    const read = readAgentPromptBudget(loose);
    if (read.status === "refused") throw new Error(read.message);
    expect(overBudget(report, read.budget)).toEqual([]);
    expect(underBudget(report, read.budget)).toEqual([
      { runtime: "pi", context: "work", measure: "laterTurnBytes", measured: 0, budget: 10 },
    ]);
  });

  it("refuses a budget that leaves a runtime or a context out", () => {
    expect(readAgentPromptBudget({ claude: {} }).status).toBe("refused");
    expect(readAgentPromptBudget(undefined).status).toBe("refused");
  });
});
