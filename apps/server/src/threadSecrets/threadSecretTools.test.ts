import type { ThreadSecretLifetime } from "@octant/contracts/thread-secrets";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PreparedThreadCommand } from "../harness/nativeHarnessComposition";
import type { NativeHarnessShellPort, NativeHarnessShellRun } from "../harness/nativeHarnessTools";
import { holdSecretValue } from "../process/secretRedaction";
import { ThreadSecretService, type ThreadSecretAuthority } from "./threadSecretService";
import { threadSecretOperations } from "./threadSecretTools";

const THREAD = "00000000-0000-4000-8000-000000000001";
const VALUE = "s3cret-Value-1234";
const services: ThreadSecretService[] = [];
afterEach(() => {
  for (const service of services.splice(0)) service.close();
});

function setup(
  over: {
    readonly run?: (input: Parameters<NativeHarnessShellPort["run"]>[0]) => NativeHarnessShellRun;
    readonly prepared?: PreparedThreadCommand;
    readonly admits?: () => boolean;
    readonly onServer?: boolean;
    readonly noShell?: boolean;
  } = {},
) {
  const state = {
    authority: { mode: "code", strict: true, commandsConfined: true } as
      | ThreadSecretAuthority
      | undefined,
    planning: false,
    events: [] as string[],
  };
  const service = new ThreadSecretService({
    uuid: () => crypto.randomUUID(),
    now: () => 0,
    journal: {
      record: (_thread, records) => {
        for (const record of records) state.events.push(record.name);
      },
      history: () => ({ open: [], lastLifetimes: new Map() }),
    },
    hold: holdSecretValue,
  });
  services.push(service);
  const stop = new AbortController();
  const finish = vi.fn(() => undefined);
  const prepare = vi.fn(async (): Promise<PreparedThreadCommand> => {
    state.events.push("asked");
    return (
      over.prepared ?? {
        status: "admitted",
        callId: "call",
        admitStart: over.admits ?? (() => true),
        finish,
      }
    );
  });
  const shellRun = vi.fn(
    async (input: Parameters<NativeHarnessShellPort["run"]>[0]): Promise<NativeHarnessShellRun> => {
      if (input.beforeLaunch?.() === false)
        return { status: "unavailable", output: "", truncated: false };
      state.events.push("ran");
      return (
        over.run?.(input) ?? { status: "ran", exitCode: 0, output: "done\n", truncated: false }
      );
    },
  );
  const operations = threadSecretOperations({
    service,
    caller: {
      windowId: "window",
      threadId: THREAD,
      turnId: "turn",
      authority: () => state.authority,
      signal: stop.signal,
    },
    commands: {
      prepare,
      shell: over.noShell === true ? undefined : { run: shellRun },
      cwd: "/project",
      extraRoots: ["/extra"],
    },
    planning: () => state.planning,
    onServer: over.onServer ?? false,
  });
  const grant = async (lifetime: ThreadSecretLifetime = "this-turn", delivery = "file") => {
    const leave =
      delivery === "handle"
        ? service.registerConsumer({ id: "computer", label: "Computer use" })
        : undefined;
    const asked = operations.requestSecret({
      operation: "request-secret",
      name: "DEPLOY_TOKEN",
      label: "Deploy token",
      kind: "token",
      reason: "Publish the preview build.",
      delivery,
    });
    const id =
      service.view("window", THREAD).requests.find(({ state }) => state === "pending")?.id ?? "";
    await service.answer(
      "window",
      THREAD,
      {
        id,
        action: "save",
        lifetime,
        fields: [{ name: "DEPLOY_TOKEN", source: "pasted", value: VALUE }],
      },
      { paired: false },
    );
    const reply = await asked;
    leave?.();
    state.events.length = 0;
    return reply;
  };
  const run = (extra: Record<string, unknown> = {}, signal?: AbortSignal) =>
    operations.runWithSecret(
      {
        operation: "run-with-secret",
        command: 'deploy --token "$OCTANT_SECRET_DEPLOY_TOKEN"',
        secrets: ["DEPLOY_TOKEN"],
        ...extra,
      },
      signal,
    );
  return { state, service, operations, grant, run, prepare, shellRun, finish, stop };
}

describe("a command run with a secret", () => {
  it("is asked about, then given the secret as a variable, in the thread's own folders", async () => {
    const h = setup();
    expect(await h.grant()).toEqual({
      result: {
        status: "saved",
        delivery: "environment",
        name: "DEPLOY_TOKEN",
        env: "OCTANT_SECRET_DEPLOY_TOKEN",
      },
      isError: false,
    });
    expect(await h.run()).toEqual({
      result: { status: "ran", exitCode: 0, output: "done\n", truncated: false },
      isError: false,
    });
    expect(h.state.events).toEqual(["asked", "thread-secret.used", "ran"]);
    expect(h.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'deploy --token "$OCTANT_SECRET_DEPLOY_TOKEN"',
        hostNote: "Octant gives it OCTANT_SECRET_DEPLOY_TOKEN",
      }),
    );
    expect(h.shellRun).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'deploy --token "$OCTANT_SECRET_DEPLOY_TOKEN"',
        cwd: "/project",
        extraRoots: ["/extra"],
        environment: { OCTANT_SECRET_DEPLOY_TOKEN: VALUE },
        callId: "call",
      }),
    );
    expect(h.finish).toHaveBeenCalledWith({ started: false });
  });

  it("never shows the value to whoever approves it", async () => {
    const h = setup();
    await h.grant();
    await h.run();
    expect(JSON.stringify(h.prepare.mock.calls)).not.toContain(VALUE);
  });

  it("shows no value it printed, whole, encoded or cut", async () => {
    const encoded = Buffer.from(`user:${VALUE}`).toString("base64");
    const h = setup({
      run: () => ({
        status: "ran",
        exitCode: 1,
        output: `${VALUE.slice(6)}\nline ${VALUE}\n${encoded}\n`,
        truncated: true,
      }),
    });
    await h.grant();
    const reply = await h.run();
    const text = JSON.stringify(reply);
    expect(text).not.toContain(VALUE);
    expect(text).not.toContain(VALUE.slice(6));
    expect(text).not.toContain(encoded.slice(8));
    expect(reply).toMatchObject({ result: { exitCode: 1, truncated: true }, isError: true });
  });

  const base64 = (text: string) => Buffer.from(text).toString("base64");
  it.each([
    ["the end of the first stream", `first line\nthen ${VALUE.slice(0, 9)}`],
    ["the start of the second stream", `fine\nlines\n[stderr]\n${VALUE.slice(7)}\nmore`],
    ["the end of the second stream", `fine\nlines\n[stderr]\nmore\n${VALUE.slice(0, 11)}`],
    ["one long line's start", `${VALUE.slice(5)}${"a".repeat(64)}`],
    ["a character's middle, at the start", `\uFFFD\uFFFD${VALUE.slice(4)}`],
    ["a character's middle, at the end", `first\nnext ${VALUE.slice(0, 9)}\uFFFD`],
    ["the start, under a line of the host's own", `A warning.\n${VALUE.slice(5)}\nnext`],
    ["an encoded value's start", `${base64(`user:${VALUE}`).slice(11)}\nnext`],
    ["an encoded value's end", `first\nnext ${base64(VALUE).slice(0, 14)}`],
  ])("shows no part of a value cut at %s", async (_name, output) => {
    const h = setup({ run: () => ({ status: "ran", exitCode: 0, output, truncated: true }) });
    await h.grant();
    const { result } = await h.run();
    const shown = (result as { output: string }).output;
    for (const whole of [VALUE, base64(VALUE), base64(`user:${VALUE}`)])
      for (let at = 0; at + 6 <= whole.length; at += 1)
        expect(shown).not.toContain(whole.slice(at, at + 6));
  });

  it("keeps the newest of a long output", async () => {
    const h = setup({
      run: () => ({
        status: "ran",
        exitCode: 0,
        output: `${"å".repeat(40_000)}the end`,
        truncated: false,
      }),
    });
    await h.grant();
    const { result } = await h.run();
    const { output, truncated } = result as { output: string; truncated: boolean };
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(24 * 1024);
    expect(output.endsWith("the end")).toBe(true);
    expect(output).not.toContain("�");
    expect(truncated).toBe(true);
  });

  it.each([
    [
      "Plan",
      "plan",
      (h: ReturnType<typeof setup>): void => {
        h.state.planning = true;
      },
    ],
    [
      "a thread that no longer admits the tool",
      "unavailable",
      (h: ReturnType<typeof setup>): void => {
        h.state.authority = undefined;
      },
    ],
    [
      "an ended secret",
      "expired",
      (h: ReturnType<typeof setup>): void => h.service.withdrawThread(THREAD),
    ],
  ] as const)("is refused in %s before anyone is asked", async (_name, failure, change) => {
    const h = setup();
    await h.grant();
    change(h);
    expect(await h.run()).toMatchObject({ result: { status: "refused", failure }, isError: true });
    expect(h.prepare).not.toHaveBeenCalled();
    expect(h.shellRun).not.toHaveBeenCalled();
  });

  it("is refused on a server Project and where the host runs no commands", async () => {
    const server = setup({ onServer: true });
    await server.grant();
    expect(await server.run()).toMatchObject({ result: { failure: "server-project" } });
    const none = setup({ noShell: true });
    await none.grant();
    expect(await none.run()).toMatchObject({ result: { failure: "no-shell" } });
    expect(server.prepare).not.toHaveBeenCalled();
    expect(none.prepare).not.toHaveBeenCalled();
  });

  it("is refused a secret that was granted as a handle", async () => {
    const h = setup();
    await h.grant("this-turn", "handle");
    expect(await h.run()).toMatchObject({ result: { failure: "unavailable" } });
    expect(h.prepare).not.toHaveBeenCalled();
  });

  it("spends nothing when it is not approved", async () => {
    const h = setup({
      prepared: { status: "refused", reason: "denied", message: "The person declined." },
    });
    await h.grant("this-command");
    expect(await h.run()).toMatchObject({
      result: { failure: "not-approved", note: "The person declined." },
    });
    expect(h.state.events).toEqual(["asked"]);
    expect(h.service.active()).toHaveLength(1);
  });

  it("gets nothing that ended while its approval waited", async () => {
    const h = setup();
    await h.grant();
    h.prepare.mockImplementationOnce(async () => {
      h.service.withdrawThread(THREAD);
      return { status: "admitted", callId: "call", admitStart: () => true, finish: h.finish };
    });
    expect(await h.run()).toMatchObject({ result: { failure: "expired" } });
    expect(h.shellRun).not.toHaveBeenCalled();
    expect(h.finish).toHaveBeenCalledWith({ started: false });
  });

  it("does not start, and spends nothing, once the turn's authority changed", async () => {
    const h = setup({ admits: () => false });
    await h.grant("this-command");
    expect(await h.run()).toMatchObject({ result: { failure: "no-shell" } });
    expect(h.state.events).toEqual(["asked"]);
    expect(h.service.active()).toHaveLength(1);
  });

  it("spends nothing when the host refuses to start it", async () => {
    const h = setup();
    h.shellRun.mockImplementationOnce(async () => ({
      status: "unavailable",
      output: "",
      truncated: false,
    }));
    await h.grant("this-command");
    expect(await h.run()).toMatchObject({ result: { failure: "no-shell" } });
    expect(h.service.active()).toHaveLength(1);
    expect(await h.run()).toMatchObject({ result: { status: "ran" } });
    expect(h.service.active()).toEqual([]);
  });

  it("stops with its call and with its turn", async () => {
    const h = setup();
    await h.grant();
    const call = new AbortController();
    await h.run({}, call.signal);
    const signal = h.shellRun.mock.calls[0]?.[0].signal;
    expect(signal?.aborted).toBe(false);
    call.abort();
    expect(signal?.aborted).toBe(true);
    h.stop.abort();
    expect(await h.run()).toMatchObject({ result: { status: "refused" } });
  });

  it.each([{}, { delivery: "handle" }])(
    "asks nobody for a handle while nothing here can use one (%o)",
    async (over) => {
      const h = setup();
      const ask = () =>
        h.operations.requestSecret({
          operation: "request-secret",
          name: "TOKEN",
          label: "Token",
          kind: "token",
          reason: "Publish.",
          ...over,
        });
      expect(await ask()).toMatchObject({
        isError: true,
        result: { status: "refused", note: expect.stringContaining("delivery file") },
      });
      expect(h.service.view("window", THREAD).requests).toEqual([]);
      h.service.registerConsumer({ id: "computer", label: "Computer use" });
      void ask();
      expect(h.service.view("window", THREAD).requests).toMatchObject([{ delivery: "handle" }]);
    },
  );

  it("refuses an input that is not the operation's", async () => {
    const h = setup();
    await h.grant();
    for (const extra of [{ environment: { A: "b" } }, { secrets: [] }, { command: "" }])
      expect(await h.run(extra)).toEqual({ result: { status: "invalid" }, isError: true });
    expect(await h.operations.requestSecret({ operation: "request-secret" })).toEqual({
      result: { status: "invalid" },
      isError: true,
    });
  });

  it("ends what the turn alone was given when its tools close", async () => {
    const h = setup();
    await h.grant();
    h.operations.close();
    expect(h.service.active()).toEqual([]);
  });

  it("reports a host that cannot hold the thread's sandbox in the host's words", async () => {
    const h = setup({
      run: () => ({
        status: "unavailable",
        output: "",
        truncated: false,
        refusal: { reason: "host-sandbox-missing", message: "This computer has no sandbox." },
      }),
    });
    await h.grant();
    expect(await h.run()).toMatchObject({
      result: { failure: "no-shell", note: "This computer has no sandbox." },
    });
  });
});
