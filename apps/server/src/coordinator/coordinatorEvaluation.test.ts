import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeCoordinatorStartInput } from "@octant/contracts";
import { decodeInputs, decision, sample } from "./coordinatorEvaluationCli";
import { expect, it, vi } from "vitest";
import { assembleCase } from "./coordinatorEvaluationInput.test-support";
import { cases, compareSamples, score, summarize } from "./coordinatorEvaluation";

it("detects unnecessary starts, missing assignments, duplicate assignments and misdirected sends", () => {
  const start = (prompt: string) => ({ operation: "start", title: prompt, prompt });
  const send = (recipients: string[], message = "Use dark blue for the primary button") => ({
    operation: "send",
    recipients,
    message,
  });
  expect(score(cases.status, [start("status")], "One worker is working.")).toBe(false);
  expect(score(cases.status, [{ operation: "help" }], "One worker is working.")).toBe(true);
  expect(score(cases.assign, [start("parser")], "I assigned both.")).toBe(false);
  expect(score(cases.assign, [start("parser"), start("parser")], "")).toBe(false);
  expect(score(cases.assign, [start("parser"), start("changelog")], "")).toBe(true);
  expect(score(cases.revise, [send([cases.revise.workers[1].reference])], "I sent it.")).toBe(
    false,
  );
  expect(score(cases.revise, [send([cases.revise.workers[0].reference])], "")).toBe(true);
  expect(
    score(
      cases.assign,
      [
        { ...start("parser"), prompt: "Fix CSV parsing. Leave the changelog to the other worker." },
        start("changelog"),
      ],
      "",
    ),
  ).toBe(true);
  const palette = [cases.revise.workers[0].reference];
  expect(
    score(cases.revise, [send(palette, "Use dark blue for the primary action button.")], ""),
  ).toBe(true);
  expect(score(cases.revise, [send(palette, "Use dark blue for the background.")], "")).toBe(false);
});

it("passes changed orchestration instructions, production roster and offered tool schema to the model", async () => {
  const first = await assembleCase(cases.revise, "Answer status questions inline.");
  const edited = await assembleCase(cases.revise, "Start workers for status questions.");
  expect(first.messages[0]?.content).toContain("Answer status questions inline.");
  expect(first.messages[0]?.content).toContain("The person's orchestration instructions");
  expect(edited.messages[0]?.content).toContain("Start workers for status questions.");
  expect(edited.messages[0]?.content).not.toContain("Answer status questions inline.");
  expect(first.messages[1]?.content).toContain(cases.revise.workers[0].reference);
  expect(first.tools[0]?.function.description).toContain("send takes recipients");
  expect(first.tools[0]?.function.description).toContain("start creates a worker");
});

it("reports incomplete runs and errors separately from completed decisions", () => {
  expect(
    summarize([
      { status: "completed", pass: true, actions: [] },
      { status: "completed", pass: false, actions: [] },
      { status: "incomplete", reason: "length", actions: [] },
      { status: "error", reason: "HTTP 503", actions: [] },
    ]),
  ).toEqual({ samples: 4, passed: 1, failed: 1, errors: 1, incomplete: 1, passRate: 0.5 });
  expect(summarize([]).passRate).toBeNull();
});

it("reports the changes in pass rate and retains the actions for each revision", () => {
  const before = [{ status: "completed", pass: false, actions: [] }] as const;
  const after = [{ status: "completed", pass: true, actions: [{ operation: "start" }] }] as const;
  expect(compareSamples(before, after)).toMatchObject({
    baseline: { runs: before, passRate: 0 },
    candidate: { runs: after, passRate: 1 },
    passRateDelta: 1,
  });
  expect(compareSamples([], after).passRateDelta).toBeNull();
});

it("refuses delegation arguments containing fields from other operations", () => {
  const attempt = (
    raw: object,
    decodeStart: (value: unknown) => unknown = decodeCoordinatorStartInput,
  ) =>
    decision(
      {
        id: "call-1",
        type: "function",
        function: { name: "threads", arguments: JSON.stringify(raw) },
      },
      "threads",
      decodeStart,
    );
  expect(
    attempt({ operation: "start", title: "CSV parser", prompt: "Fix parsing", message: "extra" }),
  ).toEqual({ operation: "invalid arguments" });
  expect(
    attempt({
      operation: "send",
      recipients: [cases.revise.workers[0].reference],
      message: "Revision",
      title: "extra",
    }),
  ).toEqual({ operation: "invalid arguments" });
  const withRoles = {
    operation: "start",
    title: "CSV parser",
    prompt: "Fix parsing",
    risk: "high",
  };
  expect(attempt(withRoles)).toMatchObject({ operation: "start" });
  expect(
    attempt(withRoles, () => {
      throw new Error("This checkout does not accept risk.");
    }),
  ).toEqual({ operation: "invalid arguments" });
});

it("loads each checkout’s hoisted worker-start contract from its server workspace", () => {
  const directory = mkdtempSync(join(tmpdir(), "coordinator-contracts-"));
  try {
    const checkouts = ["baseline", "candidate"].map((revision) => {
      const checkout = join(directory, revision);
      mkdirSync(join(checkout, "apps/server"), { recursive: true });
      const contracts = join(checkout, "node_modules/@octant/contracts");
      mkdirSync(contracts, { recursive: true });
      writeFileSync(
        join(contracts, "package.json"),
        JSON.stringify({ type: "module", exports: "./index.js" }),
      );
      writeFileSync(
        join(contracts, "index.js"),
        `export const decodeCoordinatorStartInput = input => ({ ...input, title: ${JSON.stringify(revision)} });`,
      );
      return checkout;
    });
    // The CLI resolves packages with Bun. Load both in one process to exercise its module cache too.
    const probe = `
      const { checkoutStartDecoder } = await import(process.argv[1]);
      for (const checkout of process.argv.slice(2)) {
        const decode = await checkoutStartDecoder(checkout);
        console.log(decode({ operation: "start", title: "Parser", prompt: "Fix parsing" }).title);
      }`;
    const cli = new URL("./coordinatorEvaluationCli.ts", import.meta.url).href;
    const result = execFileSync("bun", ["-e", probe, cli, ...checkouts], {
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.trim().split(/\r?\n/)).toEqual(["baseline", "candidate"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("checks the model input emitted by each checkout", async () => {
  const input = await assembleCase(cases.revise, "Use the roster.");
  const bundle = { status: input, assign: input, revise: input };
  expect(decodeInputs(bundle)).toEqual(bundle);
  expect(() =>
    decodeInputs({ ...bundle, revise: { ...input, tools: [{ function: {} }] } }),
  ).toThrow();
});

it("returns production help and per-recipient send receipts to the model", async () => {
  const assembled = await assembleCase(cases.revise, "Use the roster.");
  const input = decodeInputs({ status: assembled, assign: assembled, revise: assembled }).revise;
  const name = input.tools[0].function.name;
  const recipient = cases.revise.workers[0].reference;
  const response = (id: string, raw: object) =>
    Response.json({
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            tool_calls: [
              {
                id,
                type: "function",
                function: { name, arguments: JSON.stringify(raw) },
              },
            ],
          },
        },
      ],
    });
  const fetchModel = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(response("help", { operation: "help" }))
    .mockResolvedValueOnce(
      response("send", {
        operation: "send",
        recipients: [recipient],
        message: "Use dark blue for the primary button",
      }),
    )
    .mockResolvedValueOnce(
      Response.json({ choices: [{ finish_reason: "stop", message: { content: "Sent." } }] }),
    );
  vi.stubGlobal("fetch", fetchModel);
  try {
    const result = await sample(
      new URL("http://127.0.0.1"),
      "fixture",
      cases.revise,
      input,
      decodeCoordinatorStartInput,
    );
    expect(result).toMatchObject({ status: "completed", pass: true });
    const body = fetchModel.mock.calls[2]?.[1]?.body;
    expect(typeof body).toBe("string");
    expect(String(body)).toContain(JSON.stringify(JSON.stringify(input.help)));
    expect(String(body)).toContain(
      JSON.stringify(
        JSON.stringify([
          {
            status: "sent",
            recipient,
            messageId: "50000000-0000-4000-8000-000000010001",
            message:
              "Admitted. The recipient reads it as data at the start of its next turn; sending starts no turn there.",
          },
        ]),
      ),
    );
  } finally {
    vi.unstubAllGlobals();
  }
});
