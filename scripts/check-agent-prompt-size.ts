import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  AGENT_PROMPT_BUDGET_PATH,
  AGENT_PROMPT_CONTEXTS,
  AGENT_PROMPT_RUNTIMES,
  budgetFor,
  measureAgentPrompts,
  overBudget,
  readAgentPromptBudget,
  underBudget,
} from "../apps/server/src/agentPromptSize/agentPromptSize";

/**
 * Reports the size of the instructions and tool definitions Octant gives each
 * runtime, and fails when one grew past its recorded budget. The budget is the
 * exact size with no headroom, checked both ways, so every change is visible in
 * the budget file: raise it with `--write`, only by what the change needs, and say
 * so in the pull request.
 */
async function main() {
  const path = resolve(import.meta.dirname, "..", AGENT_PROMPT_BUDGET_PATH);
  const report = measureAgentPrompts();
  for (const runtime of AGENT_PROMPT_RUNTIMES)
    for (const context of AGENT_PROMPT_CONTEXTS) {
      const { firstPrompt, laterTurn } = report[runtime][context];
      console.log(
        `${runtime} ${context}: first prompt ${String(firstPrompt.instructionBytes)} B instructions + ${String(firstPrompt.toolBytes)} B tools (about ${String(firstPrompt.estimatedTokens)} tokens); each later turn ${String(laterTurn.instructionBytes)} B + ${String(laterTurn.toolBytes)} B (about ${String(laterTurn.estimatedTokens)} tokens)`,
      );
    }
  if (process.argv.includes("--write")) {
    await writeFile(path, `${JSON.stringify(budgetFor(report), null, 2)}\n`);
    return;
  }
  const read = readAgentPromptBudget(JSON.parse(await readFile(path, "utf8")));
  if (read.status === "refused") {
    console.error(read.message);
    process.exitCode = 1;
    return;
  }
  const overruns = overBudget(report, read.budget);
  for (const overrun of overruns)
    console.error(
      `${overrun.runtime} ${overrun.context} ${overrun.measure} grew to ${String(overrun.measured)} B, ${String(overrun.measured - overrun.budget)} B over its budget in ${AGENT_PROMPT_BUDGET_PATH}. Shorten what Octant sends, or raise the budget by exactly what the change needs with bun scripts/check-agent-prompt-size.ts --write and say so in the pull request.`,
    );
  const savings = underBudget(report, read.budget);
  for (const saving of savings)
    console.error(
      `${saving.runtime} ${saving.context} ${saving.measure} shrank to ${String(saving.measured)} B, under its ${String(saving.budget)} B budget in ${AGENT_PROMPT_BUDGET_PATH}. Record it with bun scripts/check-agent-prompt-size.ts --write.`,
    );
  if (overruns.length + savings.length > 0) process.exitCode = 1;
}

if (import.meta.main) await main();
