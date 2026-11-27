import { MAX_AGENT_MESSAGE_RECIPIENTS } from "@octant/domain";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { Schema } from "effect";
import {
  cases,
  fixtureProjectId,
  score,
  compareSamples,
  type Action,
  type EvaluationCase,
  type Sample,
} from "./coordinatorEvaluation";

const callSchema = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal("function"),
  function: Schema.Struct({ name: Schema.String, arguments: Schema.String }),
});

const responseSchema = Schema.Struct({
  choices: Schema.NonEmptyArray(
    Schema.Struct({
      finish_reason: Schema.String,
      message: Schema.Struct({
        content: Schema.optional(Schema.NullOr(Schema.String)),
        tool_calls: Schema.optional(Schema.Array(callSchema)),
      }),
    }),
  ),
});

const strict = { parseOptions: { onExcessProperty: "error" } } as const;
const sendSchema = Schema.Struct({
  operation: Schema.Literal("send"),
  recipients: Schema.NonEmptyArray(Schema.String).pipe(
    Schema.maxItems(MAX_AGENT_MESSAGE_RECIPIENTS),
  ),
  message: Schema.String.pipe(Schema.filter((message) => message.trim().length > 0)),
}).annotations(strict);
const operationSchema = Schema.Struct({ operation: Schema.String });
type StartDecoder = (value: unknown) => unknown;
const startAssignment = Schema.decodeUnknownSync(
  Schema.Struct({ title: Schema.String, prompt: Schema.String }),
);

export async function checkoutStartDecoder(cwd: string): Promise<StartDecoder> {
  const path = Bun.resolveSync("@octant/contracts", resolve(cwd, "apps/server"));
  const contracts: Record<string, unknown> = await import(path);
  const decode = contracts.decodeCoordinatorStartInput;
  if (typeof decode !== "function")
    throw new Error(`Missing coordinator start contract in ${cwd}.`);
  return (value) => decode(value);
}

const inputSchema = Schema.Struct({
  messages: Schema.NonEmptyArray(
    Schema.Struct({
      role: Schema.Literal("system", "user"),
      content: Schema.String,
    }),
  ),
  tools: Schema.NonEmptyArray(
    Schema.Struct({
      type: Schema.Literal("function"),
      function: Schema.Struct({
        name: Schema.String,
        description: Schema.String,
        parameters: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
      }),
    }),
  ),
  help: Schema.Struct({ tool: Schema.String, help: Schema.String }),
});
const projectInputSchema = Schema.Union(
  inputSchema,
  Schema.Struct({ status: Schema.Literal("unsupported"), reason: Schema.String }),
);
export const decodeInputs = Schema.decodeUnknownSync(
  Schema.Struct({
    status: inputSchema,
    assign: inputSchema,
    revise: inputSchema,
    projectQuestion: projectInputSchema,
    projectAssign: projectInputSchema,
    projectRevise: projectInputSchema,
  }),
);

const fixtureSource = "apps/server/src/coordinator";
const defaultInstructions =
  "Answer status questions from the roster. Give independent assignments to separate workers. Send revisions to the worker already assigned.";
const configuration = { temperature: 0, seed: 42, max_tokens: 768 };
const maxRounds = 6;

type Input = Schema.Schema.Type<typeof inputSchema>;

function run(cwd: string, command: string[]): string {
  const result = Bun.spawnSync(command, { cwd, stderr: "inherit" });
  if (!result.success) throw new Error(`Command failed in ${cwd}: ${command[0]}`);
  return result.stdout.toString().trim();
}

async function capture(checkout: string, instructions: string) {
  const cwd = resolve(checkout);
  const here = import.meta.dir;
  // Read the same fixtures in each process, with that checkout's production imports.
  for (const name of ["coordinatorEvaluation.ts", "coordinatorEvaluationInput.test-support.ts"]) {
    const source = await Bun.file(resolve(here, name)).text();
    if (source !== (await Bun.file(resolve(cwd, fixtureSource, name)).text())) {
      throw new Error(`Copy the same evaluation sources into ${cwd} before comparing.`);
    }
  }
  const revision = run(cwd, ["git", "rev-parse", "HEAD"]);
  if (run(cwd, ["git", "status", "--porcelain", "--untracked-files=no"]) !== "") {
    throw new Error(`Commit tracked changes in ${cwd} before comparing revisions.`);
  }
  const serialized = run(cwd, [
    process.execPath,
    `${fixtureSource}/coordinatorEvaluationInput.test-support.ts`,
    instructions,
  ]);
  return {
    revision,
    digest: createHash("sha256").update(serialized).digest("hex"),
    inputs: decodeInputs(JSON.parse(serialized)),
    decodeStart: await checkoutStartDecoder(cwd),
  };
}

export function decision(
  call: Schema.Schema.Type<typeof callSchema>,
  toolName: string | undefined,
  decodeStart: StartDecoder,
): Action {
  if (call.function.name !== toolName) return { operation: `unknown tool: ${call.function.name}` };
  try {
    const raw: unknown = JSON.parse(call.function.arguments);
    const { operation } = Schema.decodeUnknownSync(operationSchema)(raw);
    if (operation === "start") {
      const { title, prompt } = startAssignment(decodeStart(raw));
      return { operation, title, prompt };
    }
    if (operation === "send") return Schema.decodeUnknownSync(sendSchema)(raw);
    return { operation };
  } catch {
    return { operation: "invalid arguments" };
  }
}

export async function sample(
  endpoint: URL,
  model: string,
  fixture: EvaluationCase,
  input: Input,
  decodeStart: StartDecoder,
): Promise<Sample> {
  const actions: Action[] = [];
  const messages: unknown[] = [...input.messages];
  const workers = [...fixture.workers];
  const toolName = input.tools[0]?.function.name;
  try {
    for (let round = 0; round < maxRounds; round += 1) {
      const response = await fetch(endpoint, {
        redirect: "error",
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(60_000),
        body: JSON.stringify({ model, ...configuration, messages, tools: input.tools }),
      });
      if (!response.ok) throw new Error(`Model endpoint returned HTTP ${response.status}`);
      const [{ finish_reason, message }] = Schema.decodeUnknownSync(responseSchema)(
        await response.json(),
      ).choices;
      const calls = message.tool_calls ?? [];
      const returned = calls.map((call) => decision(call, toolName, decodeStart));
      if (finish_reason === "stop" && calls.length === 0) {
        return {
          status: "completed",
          pass: score(fixture, actions, message.content ?? ""),
          actions,
        };
      }
      if (finish_reason !== "tool_calls" || calls.length === 0) {
        return { status: "incomplete", reason: finish_reason, actions };
      }
      messages.push({ role: "assistant", ...message });
      for (const [index, decision] of returned.entries()) {
        let action = decision;
        const call = calls[index];
        if (call === undefined) throw new Error("Missing tool call for a recorded decision.");
        let result: object = {
          status: "refused",
          message: "Operation unavailable in this fixture.",
        };
        if (action.operation === "help") result = input.help;
        if (action.operation === "list") result = { status: "listed", threads: workers };
        if (action.operation === "start" && action.title?.trim() && action.prompt?.trim()) {
          const id = `20000000-0000-4000-8000-${String(workers.length + 10).padStart(12, "0")}`;
          const reference = `${id}@${fixtureProjectId}`;
          workers.push({ id, reference, title: action.title, state: "working" });
          result = { status: "started", reference };
          if (fixture.projectConversation === true) {
            result = { ...result, firstTurn: "started" };
            action = { ...action, startedReference: reference };
          }
        }
        if (
          action.operation === "send" &&
          action.message?.trim() &&
          action.recipients?.length &&
          action.recipients.every((ref) => workers.some((worker) => worker.reference === ref))
        ) {
          result = action.recipients.map((recipient, recipientIndex) => ({
            status: "sent",
            recipient,
            messageId: `50000000-0000-4000-8000-${String(round * 10000 + index * MAX_AGENT_MESSAGE_RECIPIENTS + recipientIndex + 1).padStart(12, "0")}`,
            message:
              "Admitted. The recipient reads it as data at the start of its next turn; sending starts no turn there.",
          }));
        }
        actions.push(
          "status" in result && result.status === "refused"
            ? { ...action, operation: `refused: ${action.operation}` }
            : action,
        );
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
      }
    }
    return { status: "incomplete", reason: "tool round limit reached", actions };
  } catch (error) {
    return {
      status: "error",
      reason: error instanceof Error ? error.message : String(error),
      actions,
    };
  }
}

async function main() {
  const [
    baselinePath,
    candidatePath,
    localEndpoint,
    model,
    count = "1",
    instructions = defaultInstructions,
  ] = process.argv.slice(2);
  if (
    !baselinePath ||
    !candidatePath ||
    !localEndpoint ||
    !model ||
    !/^\d+$/.test(count) ||
    Number(count) < 1 ||
    Number(count) > 50
  ) {
    throw new Error(
      "Usage: bun run coordinator:eval <baseline checkout> <candidate checkout> <loopback chat completions URL> <model> [repeats (1–50)] [orchestration instructions]",
    );
  }
  const endpoint = new URL(localEndpoint);
  if (
    endpoint.protocol !== "http:" ||
    endpoint.hostname !== "127.0.0.1" ||
    endpoint.username ||
    endpoint.password
  ) {
    throw new Error("Supply an HTTP endpoint bound to 127.0.0.1 for a local model.");
  }
  const baseline = await capture(baselinePath, instructions);
  const candidate = await capture(candidatePath, instructions);
  if (baseline.revision === candidate.revision) throw new Error("Supply two different revisions.");
  const results = [];
  for (const name of Object.keys(cases) as (keyof typeof cases)[]) {
    const fixture = cases[name];
    const beforeInput = baseline.inputs[name];
    const afterInput = candidate.inputs[name];
    const before: Sample[] = [];
    const after: Sample[] = [];
    for (let index = 0; index < Number(count); index += 1) {
      if (!("status" in beforeInput)) {
        before.push(await sample(endpoint, model, fixture, beforeInput, baseline.decodeStart));
      }
      if (!("status" in afterInput)) {
        after.push(await sample(endpoint, model, fixture, afterInput, candidate.decodeStart));
      }
    }
    const comparison = compareSamples(before, after);
    results.push({
      name,
      expected: fixture.expected,
      ...comparison,
      baseline: { ...comparison.baseline, ...("status" in beforeInput ? beforeInput : {}) },
      candidate: { ...comparison.candidate, ...("status" in afterInput ? afterInput : {}) },
    });
  }
  console.log(
    JSON.stringify(
      {
        baseline: { revision: baseline.revision, inputDigest: baseline.digest },
        candidate: { revision: candidate.revision, inputDigest: candidate.digest },
        provider: "local OpenAI-compatible chat completions",
        model,
        configuration,
        maxRounds,
        repeats: Number(count),
        results,
      },
      null,
      2,
    ),
  );
  if (
    results.some(
      ({ baseline, candidate }) =>
        baseline.errors + baseline.incomplete + candidate.errors + candidate.incomplete > 0,
    )
  )
    process.exitCode = 1;
}

if (import.meta.main) await main();
