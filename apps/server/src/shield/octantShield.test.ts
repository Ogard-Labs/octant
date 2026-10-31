import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderInstanceId, ProviderModelId } from "@octant/contracts";
import type { ShieldCall } from "@octant/domain/shield-judge-policy";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OctantShield,
  type ShieldModelOutcome,
  type ShieldModelPort,
  type ShieldThreadFacts,
} from "./octantShield";
import { projectCommandsIn, resolveShieldModel } from "./shieldModel";

const root = "/Users/dev/app";
const model = {
  providerInstanceId: "7b0c3f1e-2a4d-4e8b-9c1a-0d2e3f4a5b6c" as ProviderInstanceId,
  modelId: "small-model" as ProviderModelId,
};

const bash = (command: string): ShieldCall => ({
  tool: "bash",
  kind: "command",
  command,
  approvalClass: "shell-commands",
  paths: [],
  urls: [],
  arguments: JSON.stringify({ command }),
  workingDirectory: root,
});

function fakeModel(reply: ShieldModelOutcome | (() => Promise<ShieldModelOutcome>)) {
  const prompts: string[] = [];
  const port: ShieldModelPort = {
    model,
    complete: vi.fn(async ({ prompt }) => {
      prompts.push(prompt);
      return typeof reply === "function" ? reply() : reply;
    }),
  };
  return { port, prompts };
}

function shieldWith(
  port: ShieldModelPort | undefined,
  facts: Partial<ShieldThreadFacts> = {},
  options: { readonly timeoutMs?: number } = {},
) {
  return new OctantShield({
    facts: {
      reviewing: () => ({ level: "provider-review", model: port, projectId: "project-1" }),
      tainted: () => false,
      personMessages: () => ["Please tidy the README."],
      projectCommands: () => ["bun run test"],
      ...facts,
    },
    clock: () => "2026-10-31T12:00:00.000Z",
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
}

describe("Octant Shield on the host", () => {
  it("answers nothing for a thread it does not review, so the person is asked as before", async () => {
    const shield = shieldWith(undefined, { reviewing: () => undefined });
    await expect(
      shield.review({ threadId: "t", call: bash("ls"), boundRoot: root }),
    ).resolves.toBeUndefined();
  });

  it("decides by rule without calling the model", async () => {
    const { port } = fakeModel({ status: "answered", text: "{}" });
    const shield = shieldWith(port);
    const decision = await shield.review({
      threadId: "t",
      call: bash("bun run test"),
      boundRoot: root,
    });
    expect(decision).toMatchObject({
      reviewer: "octant-shield",
      verdict: "allow",
      stage: "fast-allow",
      rule: "project-command",
    });
    expect(decision?.model).toBeUndefined();
    expect(port.complete).not.toHaveBeenCalled();
  });

  it("journals the model's verdict, reason, model and latency", async () => {
    const { port } = fakeModel({
      status: "answered",
      text: '{"verdict":"allow","reason":"Listing the folder serves the request."}',
    });
    const decision = await shieldWith(port).review({
      threadId: "t",
      call: bash("ls -la"),
      boundRoot: root,
    });
    expect(decision).toEqual({
      reviewer: "octant-shield",
      verdict: "allow",
      stage: "model",
      reason: "Listing the folder serves the request.",
      model,
      latencyMs: expect.any(Number),
      decidedAt: "2026-10-31T12:00:00.000Z",
    });
  });

  it("fails closed to the person on a malformed answer, an unreachable model, a timeout, or no model", async () => {
    const malformed = fakeModel({ status: "answered", text: "Sure, go ahead." });
    expect(
      await shieldWith(malformed.port).review({ threadId: "t", call: bash("ls"), boundRoot: root }),
    ).toMatchObject({ verdict: "ask", stage: "fail-closed", rule: "model-malformed" });

    const unreachable = fakeModel({ status: "unreached" });
    expect(
      await shieldWith(unreachable.port).review({
        threadId: "t",
        call: bash("ls"),
        boundRoot: root,
      }),
    ).toMatchObject({ verdict: "ask", stage: "fail-closed", rule: "model-unreachable" });

    const throwing = fakeModel(() => Promise.reject(new Error("socket closed")));
    expect(
      await shieldWith(throwing.port).review({ threadId: "t", call: bash("ls"), boundRoot: root }),
    ).toMatchObject({ verdict: "ask", stage: "fail-closed" });

    const slow = fakeModel(() => new Promise<ShieldModelOutcome>(() => undefined));
    expect(
      await shieldWith(slow.port, {}, { timeoutMs: 5 }).review({
        threadId: "t",
        call: bash("ls"),
        boundRoot: root,
      }),
    ).toMatchObject({ verdict: "ask", stage: "fail-closed", rule: "model-timeout" });

    expect(
      await shieldWith(undefined).review({ threadId: "t", call: bash("ls"), boundRoot: root }),
    ).toMatchObject({ verdict: "ask", stage: "fail-closed", rule: "no-model" });
  });

  it("counts its model calls against the spend ceilings and asks when one refuses", async () => {
    const { port } = fakeModel({
      status: "answered",
      text: '{"verdict":"allow","reason":"Fine."}',
    });
    const settle = vi.fn();
    const admit = vi.fn(() => ({ status: "admitted" as const, settle }));
    const shield = new OctantShield({
      facts: {
        reviewing: () => ({ level: "provider-review", model: port, projectId: "project-1" }),
        tainted: () => false,
        personMessages: () => [],
        projectCommands: () => [],
      },
      spend: { admit },
      clock: () => "2026-10-31T12:00:00.000Z",
    });
    await shield.review({ threadId: "t", call: bash("ls"), boundRoot: root });
    expect(admit).toHaveBeenCalledWith({ threadId: "t", projectId: "project-1" });
    expect(settle).toHaveBeenCalledTimes(1);

    const refusing = new OctantShield({
      facts: {
        reviewing: () => ({ level: "provider-review", model: port }),
        tainted: () => false,
        personMessages: () => [],
        projectCommands: () => [],
      },
      spend: {
        admit: () => ({ status: "refused", reason: "This thread reached its token ceiling." }),
      },
      clock: () => "2026-10-31T12:00:00.000Z",
    });
    expect(
      await refusing.review({ threadId: "t", call: bash("ls"), boundRoot: root }),
    ).toMatchObject({
      verdict: "ask",
      stage: "fail-closed",
      rule: "spend-ceiling",
    });
  });

  it("pauses after 3 denials in a row and hands the next call to the person", async () => {
    const { port } = fakeModel({
      status: "answered",
      text: '{"verdict":"deny","reason":"Not asked for."}',
    });
    const shield = shieldWith(port);
    for (let index = 0; index < 3; index += 1) {
      expect(
        await shield.review({ threadId: "t", call: bash("ls"), boundRoot: root }),
      ).toMatchObject({ verdict: "deny" });
    }
    expect(await shield.review({ threadId: "t", call: bash("ls"), boundRoot: root })).toMatchObject(
      {
        verdict: "ask",
        stage: "brake",
      },
    );
    // Another thread is not paused by this one's denials.
    expect(await shield.review({ threadId: "u", call: bash("ls"), boundRoot: root })).toMatchObject(
      {
        verdict: "deny",
      },
    );
    expect(port.complete).toHaveBeenCalledTimes(4);
  });

  it("pauses for the rest of the thread after 20 denials", async () => {
    let next = 0;
    const replies = ['{"verdict":"deny","reason":"No."}', '{"verdict":"allow","reason":"Yes."}'];
    const { port } = fakeModel(async () => ({
      status: "answered",
      text: replies[next++ % 2] ?? "",
    }));
    const shield = shieldWith(port);
    for (let index = 0; index < 40; index += 1) {
      await shield.review({ threadId: "t", call: bash("ls"), boundRoot: root });
    }
    for (let index = 0; index < 3; index += 1) {
      expect(
        await shield.review({ threadId: "t", call: bash("ls"), boundRoot: root }),
      ).toMatchObject({
        verdict: "ask",
        stage: "brake",
      });
    }
  });

  it("cannot allow an egress call on a tainted thread, even when its model would", async () => {
    const { port } = fakeModel({
      status: "answered",
      text: '{"verdict":"allow","reason":"Fine."}',
    });
    const shield = shieldWith(port, { tainted: () => true });
    expect(
      await shield.review({ threadId: "t", call: bash("git push origin HEAD"), boundRoot: root }),
    ).toMatchObject({ verdict: "ask", stage: "taint-limit" });
    // A subagent's own taint counts beside its parent's.
    const clean = shieldWith(port);
    expect(
      await clean.review({
        threadId: "t",
        call: bash("curl https://example.net"),
        boundRoot: root,
        alsoTainted: true,
      }),
    ).toMatchObject({ verdict: "ask", stage: "taint-limit" });
    expect(port.complete).not.toHaveBeenCalled();
  });

  it("sends the model only the person's messages and the pending call", async () => {
    const { port, prompts } = fakeModel({
      status: "answered",
      text: '{"verdict":"ask","reason":"Unsure."}',
    });
    const shield = shieldWith(port, { personMessages: () => ["Rename the helper."] });
    await shield.review({ threadId: "t", call: bash("make rename"), boundRoot: root });
    const prompt = JSON.parse(prompts[0] ?? "{}") as Record<string, unknown>;
    expect(prompt.personMessages).toEqual(["Rename the helper."]);
    expect(prompt.pendingCall).toMatchObject({ tool: "bash", command: "make rename" });
    expect(prompt.boundFolder).toBe(root);
  });
});

describe("Shield's model and Project commands", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("uses the person's chosen endpoint, else the thread's provider with its smallest model", () => {
    const thread = {
      providerInstanceId: model.providerInstanceId,
      modelId: "big" as ProviderModelId,
    };
    const catalog = () => [
      { id: "big" as ProviderModelId, displayName: "Big" },
      { id: "fast-mini" as ProviderModelId, displayName: "Fast mini" },
    ];
    expect(resolveShieldModel({ thread, catalog })).toEqual({
      providerInstanceId: model.providerInstanceId,
      modelId: "fast-mini",
    });
    expect(resolveShieldModel({ thread, catalog: () => undefined })).toEqual({
      providerInstanceId: model.providerInstanceId,
      modelId: "big",
    });
    const chosen = {
      providerInstanceId: "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f" as ProviderInstanceId,
      modelId: "m" as ProviderModelId,
    };
    expect(resolveShieldModel({ chosen, thread, catalog })).toEqual(chosen);
  });

  it("reads the Project's own test and build commands from its root", () => {
    const dir = mkdtempSync(join(tmpdir(), "octant-shield-"));
    dirs.push(dir);
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ scripts: { test: "vitest", build: "x" } }),
    );
    writeFileSync(join(dir, "bun.lock"), "");
    expect(projectCommandsIn(dir)).toEqual(["bun run test", "bun test", "bun run build"]);
    expect(projectCommandsIn(join(dir, "missing"))).toEqual([]);
  });
});
