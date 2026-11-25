import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appToolHostLines } from "../providers/appToolHostLines";
import {
  AGENT_PROMPT_CONTEXTS,
  AGENT_PROMPT_RUNTIMES,
  measureAgentPrompts,
  NOT_MEASURED_TOOLS,
  overBudget,
  promptTools,
  readAgentPromptBudget,
} from "./agentPromptSize";

const REPOSITORY = join(import.meta.dirname, "../../../..");

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

  it("measures every guided first-party tool, or says why a turn never carries it", () => {
    const measured = new Set(
      AGENT_PROMPT_CONTEXTS.flatMap((context) => promptTools(context).map((tool) => tool.name)),
    );
    const specification = readFileSync(join(REPOSITORY, "docs/design/agent-tools.md"), "utf8");
    const listed = new Set(
      [...specification.matchAll(/`(octant_[a-z]+(?:_[a-z]+)*)`/g)].flatMap((match) =>
        match[1] === undefined ? [] : [match[1]],
      ),
    );
    const guided = [...listed].filter((name) => appToolHostLines([{ name }]).length > 0);
    expect(guided.length).toBeGreaterThan(20);
    expect(guided.filter((name) => !measured.has(name) && !(name in NOT_MEASURED_TOOLS))).toEqual(
      [],
    );
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

  it("refuses a budget that leaves a runtime or a context out", () => {
    expect(readAgentPromptBudget({ claude: {} }).status).toBe("refused");
    expect(readAgentPromptBudget(undefined).status).toBe("refused");
  });
});
