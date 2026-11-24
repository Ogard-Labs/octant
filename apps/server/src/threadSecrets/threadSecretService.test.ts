import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CredentialRequestResolution } from "@octant/contracts/credential-request";
import {
  decodeThreadSecretsView,
  ThreadSecretAnswer as ThreadSecretAnswerSchema,
  ThreadSecretRequestInput,
  ThreadSecretRequestResult,
  type ThreadSecretAnswer,
  type ThreadSecretLifetime,
} from "@octant/contracts/thread-secrets";
import { Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { Journal } from "../persistence/journal";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import type { SqliteConnection } from "../persistence/sqlitePort";
import { holdSecretValue, redactHostSecrets } from "../process/secretRedaction";
import { RememberedThreadSecrets, threadSecretMemoryJournal } from "./rememberedThreadSecrets";
import { createThreadSecretFiles, type ThreadSecretFiles } from "./threadSecretFiles";
import { threadSecretsJournal, type ThreadSecretsJournal } from "./threadSecretsJournal";
import {
  ThreadSecretService,
  type ThreadSecretAuthority,
  type ThreadSecretCaller,
} from "./threadSecretService";

const THREAD = "00000000-0000-4000-8000-000000000001";
const OTHER_THREAD = "00000000-0000-4000-8000-000000000002";
const WINDOW = "window";
const VALUE = "s3cret-Value-ångström";
const NOW = "2026-11-24T20:00:00.000Z";
const CONSUMER = { id: "computer", label: "Computer use" };
const decodeInput = Schema.decodeUnknownSync(ThreadSecretRequestInput);
const decodeThreadSecretAnswer = Schema.decodeUnknownSync(ThreadSecretAnswerSchema);
const decodeResult = Schema.decodeUnknownSync(ThreadSecretRequestResult);

let directory: string;
let root: string;
let connection: SqliteConnection;
let journal: Journal;
const services: ThreadSecretService[] = [];

beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "octant-thread-secret-service-")));
  root = join(directory, "thread-secrets");
  connection = openSqlite(join(directory, "events.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => NOW);
  const runtime = createPhase1RuntimeRegistries();
  journal = new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock: () => NOW,
  });
});
afterEach(() => {
  for (const service of services.splice(0)) service.close();
  connection.close();
  rmSync(directory, { recursive: true, force: true });
});

function host(
  options: {
    readonly files?: ThreadSecretFiles | "none";
    readonly journalFails?: () => boolean;
    readonly read?: (reference: string) => Promise<CredentialRequestResolution>;
    readonly hold?: (value: string) => () => void;
    readonly uuid?: () => string;
    readonly remembered?: RememberedThreadSecrets;
  } = {},
) {
  const state = {
    now: 1_000_000,
    asked: [] as Array<{ readonly threadId: string; readonly askId: string }>,
    authority: { mode: "code", strict: false, commandsConfined: false } as
      | ThreadSecretAuthority
      | undefined,
  };
  const real = threadSecretsJournal({
    journal,
    connection,
    uuid: () => crypto.randomUUID(),
    now: () => NOW,
  });
  const audited: ThreadSecretsJournal = {
    record: (threadId, records) => {
      if (options.journalFails?.() === true) throw new Error("The journal refused.");
      real.record(threadId, records);
    },
    history: real.history,
  };
  const { read } = options;
  const service = new ThreadSecretService({
    uuid: options.uuid ?? (() => crypto.randomUUID()),
    now: () => state.now,
    journal: audited,
    files:
      options.files === "none" ? undefined : (options.files ?? createThreadSecretFiles({ root })),
    hold: options.hold ?? holdSecretValue,
    ...(read === undefined ? {} : { readReference: (reference) => read(reference.reference) }),
    ...(options.remembered === undefined ? {} : { remembered: options.remembered }),
    onAsked: (ask) => state.asked.push(ask),
  });
  services.push(service);
  const stop = new AbortController();
  const caller: ThreadSecretCaller = {
    windowId: WINDOW,
    threadId: THREAD,
    turnId: "turn",
    authority: () => state.authority,
    signal: stop.signal,
  };
  return { service, state, caller, stop };
}

const request = (over: Record<string, unknown> = {}) =>
  decodeInput({
    operation: "request-secret",
    name: "DEPLOY_TOKEN",
    label: "Deploy token",
    kind: "token",
    reason: "Publish the preview build.",
    delivery: "file",
    ...over,
  });

const card = (service: ThreadSecretService, threadId = THREAD) => {
  const [first] = service.view(WINDOW, threadId).requests;
  if (first === undefined) throw new Error("No card is waiting.");
  return first;
};

const save = (
  service: ThreadSecretService,
  over: {
    readonly lifetime?: ThreadSecretLifetime;
    readonly value?: string;
    readonly fields?: Extract<ThreadSecretAnswer, { action: "save" }>["fields"];
    readonly paired?: boolean;
  } = {},
) => {
  const { id, fields } = card(service);
  return service.answer(
    WINDOW,
    THREAD,
    {
      id,
      action: "save",
      lifetime: over.lifetime ?? "24-hours",
      fields:
        over.fields ??
        fields.map((field) => ({
          name: field.name,
          source: "pasted",
          value: over.value ?? VALUE,
        })),
    },
    { paired: over.paired ?? false },
  );
};

const grant = async (
  context: ReturnType<typeof host>,
  input = request(),
  over: Parameters<typeof save>[1] = {},
) => {
  const asked = context.service.request(context.caller, input);
  expect(await save(context.service, over)).toEqual({ status: "accepted" });
  return decodeResult(await asked);
};

const records = () =>
  (
    connection
      .prepare(
        "SELECT payload_json FROM event_journal WHERE event_name = 'thread-secret.recorded@1' ORDER BY global_sequence",
      )
      .all() as ReadonlyArray<{ readonly payload_json: string }>
  ).map((row) => JSON.parse(row.payload_json) as Record<string, unknown>);

describe("a secret a thread's commands may read", () => {
  it.each(["code", "work"] as const)(
    "reaches a %s thread as a file and a variable, and its result never carries the value",
    async (mode) => {
      const context = host();
      context.state.authority = { mode, strict: false, commandsConfined: false };
      const result = await grant(context);
      const file = join(root, THREAD, "DEPLOY_TOKEN");
      expect(result).toEqual({
        status: "saved",
        delivery: "file-and-environment",
        name: "DEPLOY_TOKEN",
        file,
        env: "OCTANT_SECRET_DEPLOY_TOKEN",
      });
      expect(readFileSync(file, "utf8")).toBe(VALUE);
      expect(JSON.stringify([result, records(), context.service.active()])).not.toContain(VALUE);
      expect(records()).toMatchObject([{ name: "thread-secret.granted", mode }]);
    },
  );

  it("keeps the spaces of a typed value and refuses a blank one", async () => {
    const context = host();
    const asked = context.service.request(context.caller, request());
    expect(await save(context.service, { value: "   " })).toEqual({
      status: "refused",
      failure: "missing",
    });
    expect(await save(context.service, { value: "  two words  " })).toEqual({
      status: "accepted",
    });
    expect(await asked).toMatchObject({ status: "saved" });
    expect(readFileSync(join(root, THREAD, "DEPLOY_TOKEN"), "utf8")).toBe("  two words  ");
  });

  it("gives each field of one card its own file and variable", async () => {
    const context = host();
    const result = await grant(
      context,
      request({
        name: "SERVICE",
        fields: [
          { name: "EMAIL", label: "Email", secret: false },
          { name: "TOKEN", label: "Token" },
        ],
      }),
      {
        fields: [
          { name: "TOKEN", source: "pasted", value: VALUE },
          { name: "EMAIL", source: "pasted", value: "person@example.com" },
        ],
      },
    );
    expect(result).toMatchObject({
      files: {
        EMAIL: join(root, THREAD, "SERVICE_EMAIL"),
        TOKEN: join(root, THREAD, "SERVICE_TOKEN"),
      },
      env: { EMAIL: "OCTANT_SECRET_SERVICE_EMAIL", TOKEN: "OCTANT_SECRET_SERVICE_TOKEN" },
    });
    expect(readFileSync(join(root, THREAD, "SERVICE_EMAIL"), "utf8")).toBe("person@example.com");
    // A field shown as typed is not a secret to hide.
    expect(redactHostSecrets("person@example.com")).toBe("person@example.com");
  });

  it("refuses an answer that leaves a field out or names another", async () => {
    const context = host();
    void context.service.request(
      context.caller,
      request({
        fields: [
          { name: "A", label: "A" },
          { name: "B", label: "B" },
        ],
      }),
    );
    for (const fields of [
      [{ name: "A", source: "pasted", value: "x" }],
      [
        { name: "A", source: "pasted", value: "x" },
        { name: "C", source: "pasted", value: "x" },
      ],
    ] as const)
      expect(await save(context.service, { fields })).toMatchObject({ status: "refused" });
    expect(existsSync(join(root, THREAD))).toBe(false);
  });

  it.each([
    ["Strict", { mode: "code", strict: true, commandsConfined: true }, "this-turn"],
    ["a kept sandbox", { mode: "code", strict: false, commandsConfined: true }, "24-hours"],
    ["one command", { mode: "code", strict: false, commandsConfined: false }, "this-command"],
  ] as const)("is a variable with no file under %s", async (_name, authority, lifetime) => {
    const context = host();
    context.state.authority = authority;
    expect(await grant(context, request(), { lifetime })).toEqual({
      status: "saved",
      delivery: "environment",
      name: "DEPLOY_TOKEN",
      env: "OCTANT_SECRET_DEPLOY_TOKEN",
    });
    expect(existsSync(join(root, THREAD))).toBe(false);
  });

  it("is a variable on a host with nowhere private for a file", async () => {
    expect(await grant(host({ files: "none" }))).toMatchObject({ delivery: "environment" });
  });
});

describe("where a secret may not be asked for", () => {
  it("refuses Chat", async () => {
    const context = host();
    context.state.authority = { mode: "chat", strict: false, commandsConfined: false };
    expect(await context.service.request(context.caller, request())).toMatchObject({
      status: "refused",
      failure: "unsupported-mode",
    });
    expect(context.service.view(WINDOW, THREAD).requests).toEqual([]);
  });

  it("refuses a thread that no longer admits the tool", async () => {
    const context = host();
    context.state.authority = undefined;
    expect(await context.service.request(context.caller, request())).toMatchObject({
      status: "refused",
      failure: "unavailable",
    });
  });

  it("grants nothing Strict refuses when Strict came on after the card was drawn", async () => {
    const context = host();
    void context.service.request(context.caller, request());
    context.state.authority = { mode: "code", strict: true, commandsConfined: true };
    expect(await save(context.service, { lifetime: "24-hours" })).toEqual({
      status: "refused",
      failure: "refused-by-strict",
    });
    expect(records()).toEqual([]);
    expect(card(context.service)).toMatchObject({
      state: "pending",
      failure: "refused-by-strict",
    });
  });

  it("does not take a value the agent says was pasted without proof that it was", async () => {
    const context = host();
    expect(
      await context.service.request(context.caller, request({ value: "anything" })),
    ).toMatchObject({ status: "refused" });
    expect(redactHostSecrets("anything")).toBe("anything");
  });
});

describe("the card", () => {
  it("is the contract's card and reaches only the window that raised it", async () => {
    const context = host({ read: async () => ({ status: "missing" }) });
    void context.service.request(
      context.caller,
      request({ url: "https://example.com/tokens", placeholder: "Paste the token" }),
    );
    const view = decodeThreadSecretsView(context.service.view(WINDOW, THREAD));
    expect(view.requests).toMatchObject([
      {
        label: "Deploy token",
        url: "https://example.com/tokens",
        fields: [{ name: "DEPLOY_TOKEN", placeholder: "Paste the token", secret: true }],
        defaultLifetime: "24-hours",
        sources: ["pasted", "onepassword"],
      },
    ]);
    expect(context.service.view("another", THREAD).requests).toEqual([]);
    expect(context.service.view(WINDOW, OTHER_THREAD).requests).toEqual([]);
    expect(context.state.asked).toEqual([{ threadId: THREAD, askId: view.requests[0]?.id }]);
    expect(
      await context.service.answer(
        "another",
        THREAD,
        { id: card(context.service).id, action: "decline" },
        { paired: false },
      ),
    ).toEqual({ status: "gone" });
  });

  it("starts on the last lifetime the person chose for the name, after a restart too", async () => {
    const first = host();
    await grant(first, request(), { lifetime: "1-hour" });
    first.service.close();
    const second = host();
    void second.service.request(second.caller, request());
    expect(card(second.service).defaultLifetime).toBe("1-hour");
  });

  it("waits as long as it takes", async () => {
    const context = host();
    const asked = context.service.request(context.caller, request());
    context.state.now += 30 * 24 * 60 * 60_000;
    context.service.sweep();
    expect(card(context.service).state).toBe("pending");
    expect(await save(context.service)).toEqual({ status: "accepted" });
    expect(await asked).toMatchObject({ status: "saved" });
  });

  it.each([
    ["its turn stops", (c: ReturnType<typeof host>) => c.stop.abort()],
    ["its turn ends", (c: ReturnType<typeof host>) => c.service.turnEnded(THREAD, "turn")],
    ["its thread is archived", (c: ReturnType<typeof host>) => c.service.withdrawThread(THREAD)],
    ["its window goes", (c: ReturnType<typeof host>) => c.service.revokeWindow(WINDOW)],
    ["the host stops", (c: ReturnType<typeof host>) => c.service.close()],
    [
      "its thread no longer admits the tool",
      (c: ReturnType<typeof host>) => {
        c.state.authority = undefined;
        c.service.sweep();
      },
    ],
  ])("closes when %s", async (_name, end) => {
    const context = host();
    const asked = context.service.request(context.caller, request());
    const { id } = card(context.service);
    end(context);
    expect(await asked).toMatchObject({ status: "cancelled" });
    expect(
      await context.service.answer(
        WINDOW,
        THREAD,
        {
          id,
          action: "save",
          lifetime: "this-turn",
          fields: [{ name: "DEPLOY_TOKEN", source: "pasted", value: VALUE }],
        },
        { paired: false },
      ),
    ).toEqual({ status: "gone" });
    expect(records()).toEqual([]);
  });

  it("tells the agent not to ask again after a decline", async () => {
    const context = host();
    const asked = context.service.request(context.caller, request());
    await context.service.answer(
      WINDOW,
      THREAD,
      { id: card(context.service).id, action: "decline" },
      { paired: false },
    );
    expect(await asked).toMatchObject({
      status: "declined",
      note: expect.stringMatching(/do not ask again/i),
    });
  });

  it("gives the same answer for the same retry key and never a second value", async () => {
    const context = host();
    const input = request({ clientRequestId: "once" });
    const first = context.service.request(context.caller, input);
    const second = context.service.request(context.caller, input);
    expect(context.service.view(WINDOW, THREAD).requests).toHaveLength(1);
    await save(context.service);
    const answer = await first;
    expect(await second).toEqual(answer);
    expect(await context.service.request(context.caller, input)).toEqual(answer);
    expect(context.service.view(WINDOW, THREAD).requests).toEqual([]);
    expect(readFileSync(join(root, THREAD, "DEPLOY_TOKEN"), "utf8")).toBe(VALUE);
  });
});

describe("a 1Password answer", () => {
  const reference = {
    name: "DEPLOY_TOKEN",
    source: "onepassword",
    store: "onepassword",
    reference: "op://Private/Deploy/credential",
    freshEachUse: false,
  } as const;

  it("leaves the card open with the reason when the store is locked", async () => {
    const store = { status: "locked" } as CredentialRequestResolution;
    let current: CredentialRequestResolution = store;
    const context = host({ read: async () => current });
    const asked = context.service.request(context.caller, request());
    expect(await save(context.service, { fields: [reference] })).toEqual({
      status: "refused",
      failure: "locked",
    });
    expect(card(context.service).failure).toBe("locked");
    current = { status: "read", value: VALUE };
    expect(await save(context.service, { fields: [reference] })).toEqual({ status: "accepted" });
    expect(await asked).toMatchObject({ status: "saved" });
  });

  it("is refused from a phone", async () => {
    const context = host({ read: async () => ({ status: "read", value: VALUE }) });
    void context.service.request(context.caller, request());
    expect(await save(context.service, { fields: [reference], paired: true })).toEqual({
      status: "refused",
      failure: "not-linked",
    });
    expect(await save(context.service, { paired: true })).toEqual({ status: "accepted" });
  });

  it("grants nothing when the turn stopped while the item was read", async () => {
    let finish: (value: CredentialRequestResolution) => void = () => undefined;
    const context = host({ read: () => new Promise((resolve) => (finish = resolve)) });
    const asked = context.service.request(context.caller, request());
    const answered = save(context.service, { fields: [reference] });
    context.stop.abort();
    finish({ status: "read", value: VALUE });
    expect(await answered).toEqual({ status: "gone" });
    expect(await asked).toMatchObject({ status: "cancelled" });
    expect(records()).toEqual([]);
    expect(context.service.active()).toEqual([]);
  });

  it("follows a rotated item at every use and hides the new value too", async () => {
    let value = VALUE;
    const context = host({ read: async () => ({ status: "read", value }) });
    context.service.registerConsumer(CONSUMER);
    const result = await grant(context, request({ delivery: "handle" }), { fields: [reference] });
    value = "rotated-Value-9";
    if (result.status !== "saved" || !("handle" in result)) throw new Error("No handle.");
    expect(
      await context.service.redeem({
        consumerId: CONSUMER.id,
        caller: context.caller,
        handle: result.handle,
        signal: new AbortController().signal,
      }),
    ).toMatchObject({ status: "redeemed", value: "rotated-Value-9" });
    expect(redactHostSecrets(`${VALUE} rotated-Value-9`)).toBe(
      "[redacted secret] [redacted secret]",
    );
    context.service.close();
    expect(redactHostSecrets("rotated-Value-9")).toBe("rotated-Value-9");
  });
});

describe("a one-use handle", () => {
  const redeem = (
    context: ReturnType<typeof host>,
    handle: string,
    over: {
      readonly threadId?: string;
      readonly turnId?: string;
      readonly signal?: AbortSignal;
    } = {},
  ) =>
    context.service.redeem({
      consumerId: CONSUMER.id,
      caller: {
        ...context.caller,
        threadId: over.threadId ?? THREAD,
        turnId: over.turnId ?? "turn",
      },
      handle,
      signal: over.signal ?? new AbortController().signal,
    });
  const handleOf = (result: ThreadSecretRequestResult): string => {
    if (result.status !== "saved" || !("handle" in result)) throw new Error("No handle.");
    return result.handle;
  };

  it("is redeemed once, by a registered consumer, for its own thread", async () => {
    const context = host();
    const handle = handleOf(await grant(context, request({ delivery: "handle" })));
    expect(existsSync(join(root, THREAD))).toBe(false);
    expect(await redeem(context, handle)).toMatchObject({ status: "refused" });
    const leave = context.service.registerConsumer(CONSUMER);
    expect(() => context.service.registerConsumer(CONSUMER)).toThrow();
    expect(await redeem(context, handle, { threadId: OTHER_THREAD })).toMatchObject({
      status: "refused",
    });
    expect(await redeem(context, handle)).toMatchObject({ status: "redeemed", value: VALUE });
    expect(await redeem(context, handle)).toMatchObject({ status: "refused" });
    leave();
    expect(records().map((record) => record.name)).toEqual([
      "thread-secret.granted",
      "thread-secret.used",
    ]);
  });

  it("is handed to one of two redeemers that race", async () => {
    const context = host();
    context.service.registerConsumer(CONSUMER);
    const handle = handleOf(await grant(context, request({ delivery: "handle" })));
    const results = await Promise.all([redeem(context, handle), redeem(context, handle)]);
    expect(results.map((result) => result.status).sort()).toEqual(["redeemed", "refused"]);
  });

  it("is spent but hands nothing over when the use cannot be recorded", async () => {
    let fails = false;
    const context = host({ journalFails: () => fails });
    context.service.registerConsumer(CONSUMER);
    const handle = handleOf(await grant(context, request({ delivery: "handle" })));
    fails = true;
    expect(await redeem(context, handle)).toEqual({ status: "refused", failure: "unavailable" });
    fails = false;
    expect(await redeem(context, handle)).toMatchObject({ status: "refused" });
  });

  it("is issued again without a card while the secret lasts, one per field", async () => {
    const context = host();
    context.service.registerConsumer(CONSUMER);
    const input = request({
      name: "SERVICE",
      delivery: "handle",
      fields: [
        { name: "EMAIL", label: "Email", secret: false },
        { name: "PASSWORD", label: "Password" },
      ],
    });
    const first = await grant(context, input, {
      lifetime: "1-hour",
      fields: [
        { name: "EMAIL", source: "pasted", value: "person@example.com" },
        { name: "PASSWORD", source: "pasted", value: VALUE },
      ],
    });
    const second = await context.service.request(context.caller, input);
    expect(context.service.view(WINDOW, THREAD).requests).toEqual([]);
    if (
      first.status !== "saved" ||
      second.status !== "saved" ||
      !("handles" in first) ||
      !("handles" in second)
    )
      throw new Error("No handles.");
    expect(second.handles.PASSWORD).not.toBe(first.handles.PASSWORD);
    for (const handle of [first.handles.PASSWORD, second.handles.PASSWORD])
      expect(await redeem(context, handle ?? "")).toMatchObject({ value: VALUE });
    expect(await redeem(context, second.handles.EMAIL ?? "")).toMatchObject({
      value: "person@example.com",
    });
    context.state.now += 60 * 60_000;
    void context.service.request(context.caller, input);
    expect(context.service.view(WINDOW, THREAD).requests).toHaveLength(1);
  });

  it("is never widened into a file without a new card", async () => {
    const context = host();
    await grant(context, request({ delivery: "handle" }));
    void context.service.request(context.caller, request({ delivery: "file" }));
    expect(context.service.view(WINDOW, THREAD).requests).toHaveLength(1);
  });

  it("ends a secret given for one command", async () => {
    const context = host();
    context.service.registerConsumer(CONSUMER);
    const handle = handleOf(
      await grant(context, request({ delivery: "handle" }), { lifetime: "this-command" }),
    );
    expect(await redeem(context, handle)).toMatchObject({ status: "redeemed" });
    expect(context.service.active()).toEqual([]);
    expect(records().at(-1)).toMatchObject({
      name: "thread-secret.revoked",
      cause: "command-ended",
    });
  });

  it("stays redacted after it is redeemed and its secret has ended", async () => {
    const context = host();
    context.service.registerConsumer(CONSUMER);
    const handle = handleOf(
      await grant(context, request({ delivery: "handle" }), { lifetime: "this-command" }),
    );
    const redeemed = await redeem(context, handle);
    if (redeemed.status !== "redeemed") throw new Error("Not redeemed.");
    expect(context.service.active()).toEqual([]);
    redeemed.done();
    expect(redactHostSecrets(`error: ${VALUE}`)).toBe("error: [redacted secret]");
  });

  it.each(["done", "turn", "thread", "close"] as const)(
    "keeps a value the item has rotated past redacted for its consumer until %s",
    async (end) => {
      let value = VALUE;
      const context = host({ read: async () => ({ status: "read", value }) });
      context.service.registerConsumer(CONSUMER);
      const input = request({ delivery: "handle" });
      const first = await grant(context, input, {
        fields: [
          {
            name: "DEPLOY_TOKEN",
            source: "onepassword",
            store: "onepassword",
            reference: "op://Private/Deploy/credential",
            freshEachUse: false,
          },
        ],
      });
      const next = async () => handleOf(await context.service.request(context.caller, input));
      value = "rotated-Value-1";
      const using = await redeem(context, handleOf(first));
      value = "rotated-Value-2";
      const later = await redeem(context, await next());
      if (later.status === "redeemed") later.done();
      expect(redactHostSecrets("rotated-Value-1")).toBe("[redacted secret]");
      if (using.status !== "redeemed") throw new Error("Not redeemed.");
      if (end === "done") using.done();
      else if (end === "turn") context.service.turnEnded(THREAD, "turn");
      else if (end === "thread") context.service.withdrawThread(THREAD);
      else context.service.close();
      expect(redactHostSecrets("rotated-Value-1")).toBe("rotated-Value-1");
      using.done();
    },
  );

  it("is refused once Strict refuses its lifetime, or the thread no longer admits the tool", async () => {
    const context = host();
    context.service.registerConsumer(CONSUMER);
    const input = request({ delivery: "handle" });
    const handle = handleOf(await grant(context, input));
    context.state.authority = { mode: "code", strict: true, commandsConfined: true };
    expect(await redeem(context, handle)).toEqual({
      status: "refused",
      failure: "refused-by-strict",
    });
    context.state.authority = undefined;
    expect(await redeem(context, handle)).toEqual({ status: "refused", failure: "unavailable" });
  });

  it.each([
    ["its consumer leaves", (c: ReturnType<typeof host>, leave: () => void) => leave()],
    ["its time runs out", (c: ReturnType<typeof host>) => (c.state.now += 2 * 60 * 60_000)],
    [
      "Strict comes on",
      (c: ReturnType<typeof host>) => {
        c.state.authority = { mode: "chat", strict: true, commandsConfined: true };
      },
    ],
    ["the turn stops", (c: ReturnType<typeof host>) => c.stop.abort()],
    [
      "the person revokes it",
      (c: ReturnType<typeof host>) => {
        const [secret] = c.service.active(THREAD);
        c.service.revoke(THREAD, secret?.id ?? "");
      },
    ],
  ] as const)("hands nothing over when %s while the item is read", async (_name, happen) => {
    let finish: ((value: CredentialRequestResolution) => void) | undefined;
    let reads = 0;
    const context = host({
      read: () =>
        (reads += 1) === 1
          ? Promise.resolve({ status: "read", value: VALUE })
          : new Promise((resolve) => (finish = resolve)),
    });
    const leave = context.service.registerConsumer(CONSUMER);
    const handle = handleOf(
      await grant(context, request({ delivery: "handle" }), {
        lifetime: "1-hour",
        fields: [
          {
            name: "DEPLOY_TOKEN",
            source: "onepassword",
            store: "onepassword",
            reference: "op://Private/Deploy/credential",
            freshEachUse: false,
          },
        ],
      }),
    );
    const redeemed = redeem(context, handle);
    happen(context, leave);
    finish?.({ status: "read", value: "rotated-Value-9" });
    expect(await redeemed).toMatchObject({ status: "refused" });
    expect(records().some((record) => record.name === "thread-secret.used")).toBe(false);
  });

  it("serves one turn's secret to no other turn", async () => {
    const context = host();
    context.service.registerConsumer(CONSUMER);
    const input = request({ delivery: "handle" });
    const handle = handleOf(await grant(context, input, { lifetime: "this-turn" }));
    expect(await redeem(context, handle, { turnId: "next" })).toEqual({
      status: "refused",
      failure: "expired",
    });
    void context.service.request({ ...context.caller, turnId: "next" }, input);
    expect(context.service.view(WINDOW, THREAD).requests).toHaveLength(1);
  });

  it("holds only the granted value and the latest one of an item that keeps rotating", async () => {
    let count = 0;
    const holds = { live: 0 };
    const context = host({
      read: async () => ({ status: "read", value: `rotating-Value-${(count += 1)}` }),
      hold: () => {
        holds.live += 1;
        return () => (holds.live -= 1);
      },
    });
    context.service.registerConsumer(CONSUMER);
    const input = request({ delivery: "handle" });
    let result = await grant(context, input, {
      fields: [
        {
          name: "DEPLOY_TOKEN",
          source: "onepassword",
          store: "onepassword",
          reference: "op://Private/Deploy/credential",
          freshEachUse: false,
        },
      ],
    });
    for (let round = 0; round < 20; round += 1) {
      const redeemed = await redeem(context, handleOf(result));
      if (redeemed.status === "redeemed") redeemed.done();
      result = await context.service.request(context.caller, input);
    }
    expect(holds.live).toBe(2);
    context.service.close();
    expect(holds.live).toBe(0);
  });
});

describe("a secret lent to one command", () => {
  const lend = (
    context: ReturnType<typeof host>,
    names: ReadonlyArray<string> = ["DEPLOY_TOKEN"],
    over: {
      readonly turnId?: string;
      readonly threadId?: string;
      readonly signal?: AbortSignal;
    } = {},
  ) =>
    context.service.lend({
      caller: {
        ...context.caller,
        turnId: over.turnId ?? "turn",
        threadId: over.threadId ?? THREAD,
      },
      names,
      signal: over.signal ?? new AbortController().signal,
    });
  const started = async (...input: Parameters<typeof lend>) => {
    const loan = await lend(...input);
    return loan.status === "lent" && loan.start() ? loan : { ...loan, status: "refused" as const };
  };
  const item = {
    name: "DEPLOY_TOKEN",
    source: "onepassword",
    store: "onepassword",
    reference: "op://Private/Deploy/credential",
    freshEachUse: true,
  } as const;

  it.each([
    ["Strict", { mode: "code", strict: true, commandsConfined: true }, "this-turn"],
    ["a file beside it", { mode: "work", strict: false, commandsConfined: false }, "24-hours"],
  ] as const)(
    "is a variable with %s, and its use is recorded",
    async (_name, authority, lifetime) => {
      const context = host();
      context.state.authority = authority;
      await grant(context, request(), { lifetime });
      const loan = await lend(context);
      expect(loan).toMatchObject({
        status: "lent",
        environment: { OCTANT_SECRET_DEPLOY_TOKEN: VALUE },
      });
      expect(records().at(-1)).toMatchObject({ name: "thread-secret.granted" });
      expect(loan.status === "lent" && loan.start()).toBe(true);
      expect(loan.status === "lent" && loan.start()).toBe(false);
      expect(records().at(-1)).toMatchObject({ name: "thread-secret.used", use: "command" });
      expect(JSON.stringify(records())).not.toContain(VALUE);
      expect(await lend(context)).toMatchObject({ status: "lent" });
    },
  );

  it("holds nothing more of a value once its command is done", async () => {
    const holds = { live: 0 };
    const context = host({
      hold: () => {
        holds.live += 1;
        return () => (holds.live -= 1);
      },
    });
    await grant(context);
    const before = holds.live;
    for (let round = 0; round < 5; round += 1) {
      const loan = await started(context);
      if ("done" in loan) loan.done();
    }
    expect(holds.live).toBe(before);
  });

  it("gives several fields at once, each under its own variable", async () => {
    const context = host();
    await grant(
      context,
      request({
        name: "SERVICE",
        fields: [
          { name: "EMAIL", label: "Email", secret: false },
          { name: "TOKEN", label: "Token" },
        ],
      }),
      {
        fields: [
          { name: "EMAIL", source: "pasted", value: "person@example.com" },
          { name: "TOKEN", source: "pasted", value: VALUE },
        ],
      },
    );
    expect(await lend(context, ["SERVICE_EMAIL", "SERVICE_TOKEN"])).toMatchObject({
      environment: {
        OCTANT_SECRET_SERVICE_EMAIL: "person@example.com",
        OCTANT_SECRET_SERVICE_TOKEN: VALUE,
      },
    });
    expect(await lend(context, ["SERVICE"])).toEqual({ status: "refused", failure: "expired" });
  });

  it("is never one the person granted as a handle", async () => {
    const context = host();
    await grant(context, request({ delivery: "handle" }));
    expect(await lend(context)).toEqual({ status: "refused", failure: "unavailable" });
    expect(context.service.refusesLoan(context.caller, ["DEPLOY_TOKEN"], context.stop.signal)).toBe(
      "unavailable",
    );
  });

  it("is refused to another thread or turn, under a rule it breaks, or once it ended", async () => {
    const context = host();
    await grant(context, request(), { lifetime: "24-hours" });
    expect(await lend(context, undefined, { threadId: OTHER_THREAD })).toMatchObject({
      failure: "expired",
    });
    context.state.authority = { mode: "code", strict: true, commandsConfined: true };
    expect(await lend(context)).toMatchObject({ failure: "refused-by-strict" });
    context.state.authority = undefined;
    expect(await lend(context)).toMatchObject({ failure: "unavailable" });
    context.state.authority = { mode: "code", strict: false, commandsConfined: false };
    await grant(context, request({ name: "TURN" }), { lifetime: "this-turn" });
    expect(await lend(context, ["TURN"], { turnId: "next" })).toMatchObject({ failure: "expired" });
    const stopped = new AbortController();
    stopped.abort();
    expect(await lend(context, undefined, { signal: stopped.signal })).toMatchObject({
      failure: "unavailable",
    });
    context.service.withdrawThread(THREAD);
    expect(await lend(context)).toMatchObject({ failure: "expired" });
    expect(records().some((record) => record.name === "thread-secret.used")).toBe(false);
  });

  it("goes to one command when that is all the person allowed", async () => {
    const context = host();
    await grant(context, request(), { lifetime: "this-command" });
    const loans = await Promise.all([started(context), started(context)]);
    expect(loans.map((loan) => loan.status).sort()).toEqual(["lent", "refused"]);
    expect(context.service.active()).toEqual([]);
    expect(redactHostSecrets(`printed ${VALUE}`)).toBe("printed [redacted secret]");
  });

  it("is not spent by a command that was refused", async () => {
    let status: CredentialRequestResolution = { status: "read", value: VALUE };
    const context = host({ read: async () => status });
    await grant(context, request(), { lifetime: "this-command", fields: [item] });
    status = { status: "locked" };
    expect(await lend(context)).toEqual({ status: "refused", failure: "locked" });
    status = { status: "read", value: VALUE };
    const never = await lend(context);
    expect(await lend(context)).toMatchObject({ status: "refused", failure: "unavailable" });
    if (never.status === "lent") never.done();
    expect(never.status === "lent" && never.start()).toBe(false);
    expect(context.service.active()).toHaveLength(1);
    expect(records().some((record) => record.name === "thread-secret.used")).toBe(false);
    expect(await started(context)).toMatchObject({ status: "lent" });
    expect(await lend(context)).toMatchObject({ status: "refused" });
  });

  it.each([
    [
      "the person revokes it",
      (c: ReturnType<typeof host>) => {
        c.service.revoke(THREAD, c.service.active(THREAD)[0]?.id ?? "");
      },
    ],
    [
      "its time is up",
      (c: ReturnType<typeof host>) => {
        c.state.now += 25 * 60 * 60_000;
      },
    ],
    [
      "Strict comes on",
      (c: ReturnType<typeof host>) => {
        c.state.authority = { mode: "code", strict: true, commandsConfined: true };
      },
    ],
    ["its thread is archived", (c: ReturnType<typeof host>) => c.service.withdrawThread(THREAD)],
    ["the turn stops", (c: ReturnType<typeof host>) => c.stop.abort()],
  ] as const)("does not start a command when %s as it is about to", async (_name, happen) => {
    const context = host();
    await grant(context);
    const loan = await lend(context);
    happen(context);
    expect(loan.status === "lent" && loan.start()).toBe(false);
    expect(records().some((record) => record.name === "thread-secret.used")).toBe(false);
  });

  it("gives every secret asked for or none", async () => {
    const context = host();
    await grant(context, request());
    expect(await lend(context, ["DEPLOY_TOKEN", "MISSING"])).toEqual({
      status: "refused",
      failure: "expired",
    });
    expect(records().some((record) => record.name === "thread-secret.used")).toBe(false);
  });

  it("is not given when its use cannot be recorded", async () => {
    let fails = false;
    const context = host({ journalFails: () => fails });
    await grant(context, request(), { lifetime: "this-command" });
    fails = true;
    const refused = await lend(context);
    expect(refused.status === "lent" && refused.start()).toBe(false);
    if (refused.status === "lent") refused.done();
    fails = false;
    expect(await started(context)).toMatchObject({ status: "lent" });
  });

  it("is read at each use, kept nowhere and written nowhere, when the person chose that", async () => {
    let value = "first-Value-1";
    let reads = 0;
    const holds = new Set<string>();
    const context = host({
      read: async () => {
        reads += 1;
        return { status: "read", value };
      },
      hold: (held) => {
        holds.add(held);
        return () => holds.delete(held);
      },
    });
    expect(await grant(context, request(), { fields: [item] })).toEqual({
      status: "saved",
      delivery: "each-use",
      name: "DEPLOY_TOKEN",
      env: "OCTANT_SECRET_DEPLOY_TOKEN",
    });
    expect(existsSync(join(root, THREAD))).toBe(false);
    expect([...holds]).toEqual([]);
    const first = await started(context);
    expect(first).toMatchObject({ environment: { OCTANT_SECRET_DEPLOY_TOKEN: "first-Value-1" } });
    value = "second-Value-2";
    const second = await started(context);
    expect(second).toMatchObject({ environment: { OCTANT_SECRET_DEPLOY_TOKEN: "second-Value-2" } });
    expect(reads).toBe(3);
    if (first.status === "lent") first.done();
    if (second.status === "lent") second.done();
    expect([...holds]).not.toContain("first-Value-1");
  });

  it("is read at each redemption of a handle too, when the person chose that", async () => {
    let value = VALUE;
    const context = host({ read: async () => ({ status: "read", value }) });
    context.service.registerConsumer(CONSUMER);
    const result = await grant(context, request({ delivery: "handle" }), { fields: [item] });
    if (result.status !== "saved" || !("handle" in result)) throw new Error("No handle.");
    value = "rotated-Value-9";
    expect(
      await context.service.redeem({
        consumerId: CONSUMER.id,
        caller: context.caller,
        handle: result.handle,
        signal: new AbortController().signal,
      }),
    ).toMatchObject({ status: "redeemed", value: "rotated-Value-9" });
  });
});

describe("a secret the person asked Octant to remember", () => {
  function memory(
    over: {
      readonly journalFails?: () => boolean;
      readonly setFails?: () => boolean;
      readonly deleteFails?: () => boolean;
    } = {},
  ) {
    const stored = new Map<string, string>();
    const real = threadSecretMemoryJournal({
      journal,
      connection,
      uuid: () => crypto.randomUUID(),
      now: () => NOW,
    });
    const open = () =>
      new RememberedThreadSecrets({
        journal: {
          record: (record) => {
            if (over.journalFails?.() === true) throw new Error("The journal refused.");
            real.record(record);
          },
          history: real.history,
        },
        store: {
          set: async (id, value) => {
            if (over.setFails?.() === true) throw new Error("The store is locked.");
            stored.set(id, value);
          },
          resolve: async (id) => {
            const value = stored.get(id);
            if (value === undefined) throw new Error("Missing.");
            return value;
          },
          delete: async (id) => {
            if (over.deleteFails?.() === true) throw new Error("The store is locked.");
            stored.delete(id);
          },
        },
        uuid: () => crypto.randomUUID(),
      });
    return { open, stored };
  }
  const memoryText = () =>
    JSON.stringify(
      connection
        .prepare(
          "SELECT payload_json FROM event_journal WHERE event_name = 'thread-secret-memory.recorded@1'",
        )
        .all(),
    );

  it("is offered on a later card for its name, in another thread and after a restart", async () => {
    const { open, stored } = memory();
    const first = host({ remembered: open() });
    await grant(first, request(), { lifetime: "remember" });
    expect([...stored.values()]).toEqual([VALUE]);
    expect(memoryText()).not.toContain(VALUE);
    first.service.close();
    const second = host({ remembered: open() });
    const asked = second.service.request(second.caller, request());
    const offered = card(second.service);
    expect(offered).toMatchObject({
      sources: ["pasted", "remembered"],
      remembered: [{ name: "DEPLOY_TOKEN", source: "pasted" }],
      defaultLifetime: "remember",
    });
    expect(
      await save(second.service, {
        lifetime: "1-hour",
        fields: [
          {
            name: "DEPLOY_TOKEN",
            source: "remembered",
            rememberedId: offered.remembered[0]?.id ?? "",
          },
        ],
      }),
    ).toEqual({ status: "accepted" });
    expect(await asked).toMatchObject({ status: "saved" });
    expect(readFileSync(join(root, THREAD, "DEPLOY_TOKEN"), "utf8")).toBe(VALUE);
    expect(second.service.active()).toMatchObject([{ source: "remembered", lifetime: "1-hour" }]);
    expect(stored.size).toBe(1);
  });

  it("is used only when the person picks it, never because it exists", async () => {
    const { open } = memory();
    const context = host({ remembered: open() });
    await grant(context, request(), { lifetime: "remember" });
    context.service.withdrawThread(THREAD);
    void context.service.request(context.caller, request());
    expect(context.service.view(WINDOW, THREAD).requests).toHaveLength(1);
    expect(context.service.active()).toEqual([]);
  });

  it("is not offered for another name or for an account password", async () => {
    const { open } = memory();
    const context = host({ remembered: open() });
    await grant(context, request(), { lifetime: "remember" });
    const id = open().list()[0]?.id ?? "";
    context.service.withdrawThread(THREAD);
    for (const over of [{ name: "OTHER" }, { kind: "account-password" }]) {
      void context.service.request(context.caller, request(over));
      const offered = card(context.service);
      expect(offered.remembered).toEqual([]);
      expect(offered.sources).not.toContain("remembered");
      expect(
        await save(context.service, {
          lifetime: "1-hour",
          fields: [{ name: offered.fields[0]?.name ?? "", source: "remembered", rememberedId: id }],
        }),
      ).toEqual({ status: "refused", failure: "missing" });
      context.service.withdrawThread(THREAD);
    }
  });

  it("is an address and no value for a 1Password item, read again and never from a phone", async () => {
    let value = VALUE;
    const { open, stored } = memory();
    const context = host({ remembered: open(), read: async () => ({ status: "read", value }) });
    await grant(context, request({ delivery: "handle" }), {
      lifetime: "remember",
      fields: [
        {
          name: "DEPLOY_TOKEN",
          source: "onepassword",
          store: "onepassword",
          reference: "op://Private/Deploy/credential",
          freshEachUse: false,
        },
      ],
    });
    expect(stored.size).toBe(0);
    expect(memoryText()).toContain("op://Private/Deploy/credential");
    context.service.withdrawThread(THREAD);
    value = "rotated-Value-9";
    const asked = context.service.request(context.caller, request());
    const fields = [
      {
        name: "DEPLOY_TOKEN",
        source: "remembered" as const,
        rememberedId: card(context.service).remembered[0]?.id ?? "",
      },
    ];
    expect(await save(context.service, { fields, paired: true })).toEqual({
      status: "refused",
      failure: "not-linked",
    });
    expect(await save(context.service, { fields })).toEqual({ status: "accepted" });
    await asked;
    expect(readFileSync(join(root, THREAD, "DEPLOY_TOKEN"), "utf8")).toBe("rotated-Value-9");
  });

  it("replaces what was remembered under its name, and keeps one", async () => {
    const { open, stored } = memory();
    const context = host({ remembered: open() });
    await grant(context, request(), { lifetime: "remember" });
    context.service.withdrawThread(THREAD);
    await grant(context, request(), { lifetime: "remember", value: "second-Value-1" });
    expect([...stored.values()]).toEqual(["second-Value-1"]);
    expect(open().list()).toHaveLength(1);
  });

  it.each(["journal", "store", "grant"] as const)(
    "leaves nothing kept when the %s refuses",
    async (what) => {
      let fails = false;
      const { open, stored } = memory({
        journalFails: () => fails && what === "journal",
        setFails: () => fails && what === "store",
      });
      const context = host({
        remembered: open(),
        journalFails: () => fails && what === "grant",
      });
      void context.service.request(context.caller, request());
      fails = true;
      expect(await save(context.service, { lifetime: "remember" })).toEqual({
        status: "refused",
        failure: "unavailable",
      });
      expect(stored.size).toBe(0);
      expect(open().list()).toEqual([]);
      expect(context.service.active()).toEqual([]);
      expect(card(context.service).state).toBe("pending");
    },
  );

  it("leaves nothing kept when the turn stops while it is being kept", async () => {
    const stored = new Map<string, string>();
    let finish: () => void = () => undefined;
    const context = host({
      remembered: new RememberedThreadSecrets({
        journal: { record: () => undefined, history: () => [] },
        store: {
          set: (id, value) =>
            new Promise((resolve) => {
              stored.set(id, value);
              finish = resolve;
            }),
          resolve: async () => "",
          delete: async (id) => void stored.delete(id),
        },
        uuid: () => crypto.randomUUID(),
      }),
    });
    void context.service.request(context.caller, request());
    const answered = save(context.service, { lifetime: "remember" });
    context.stop.abort();
    finish();
    expect(await answered).toEqual({ status: "gone" });
    expect(stored.size).toBe(0);
    expect(context.service.active()).toEqual([]);
  });

  it("stays listed when its value could not be removed", async () => {
    let fails = true;
    const { open, stored } = memory({ deleteFails: () => fails });
    const remembered = open();
    const id = await remembered.remember("TOKEN", { kind: "value", value: VALUE });
    expect(await remembered.forget(id ?? "")).toBe(false);
    expect(remembered.list()).toHaveLength(1);
    fails = false;
    expect(await remembered.forget(id ?? "")).toBe(true);
    expect(remembered.list()).toEqual([]);
    expect(stored.size).toBe(0);
    expect(open().list()).toEqual([]);
  });

  it("is not offered on a host with no credential store", () => {
    const context = host();
    void context.service.request(context.caller, request());
    expect(card(context.service).lifetimes).not.toContain("remember");
  });
});

describe("what an agent cannot arrange", () => {
  it("keeps a value redacted although the agent marked its field not secret", async () => {
    const context = host({ read: async () => ({ status: "read", value: VALUE }) });
    const fields = [{ name: "PASSWORD", label: "Password", secret: false }];
    await grant(context, request({ kind: "account-password", fields }), { lifetime: "1-hour" });
    expect(redactHostSecrets(VALUE)).toBe("[redacted secret]");
    context.service.withdrawThread(THREAD);
    await grant(context, request({ fields }), {
      fields: [
        {
          name: "PASSWORD",
          source: "onepassword",
          store: "onepassword",
          reference: "op://Private/Deploy/credential",
          freshEachUse: false,
        },
      ],
    });
    expect(redactHostSecrets(VALUE)).toBe("[redacted secret]");
  });

  it("shows a link as the browser will open it", () => {
    const context = host();
    void context.service.request(context.caller, request({ url: "https://\u0430pple.com/a" }));
    expect(card(context.service).url).toBe("https://xn--pple-43d.com/a");
  });

  it("keeps other threads able to ask however many cards one opens", async () => {
    const context = host();
    for (let index = 0; index < 20; index += 1)
      void context.service.request(context.caller, request({ name: `TOKEN_${index}` }));
    expect(context.service.view(WINDOW, THREAD).requests).toHaveLength(2);
    void context.service.request({ ...context.caller, threadId: OTHER_THREAD }, request());
    expect(context.service.view(WINDOW, OTHER_THREAD).requests).toHaveLength(1);
  });

  it("gets no earlier answer for another request under the same retry key", async () => {
    const context = host();
    await grant(context, request({ clientRequestId: "key" }));
    expect(
      await context.service.request(
        context.caller,
        request({ clientRequestId: "key", name: "OTHER", kind: "account-password" }),
      ),
    ).toMatchObject({ status: "refused" });
  });

  it("is not told a secret is saved after it ended", async () => {
    const context = host();
    const input = request({ clientRequestId: "key" });
    await grant(context, input, { lifetime: "1-hour" });
    context.state.now += 60 * 60_000;
    expect(await context.service.request(context.caller, input)).toMatchObject({
      status: "refused",
      failure: "expired",
    });
  });

  it("does not inherit a token's lifetime for an account password of the same name", async () => {
    const context = host();
    await grant(context, request(), { lifetime: "until-archived" });
    void context.service.request(
      context.caller,
      request({ kind: "account-password", delivery: "handle" }),
    );
    expect(card(context.service).defaultLifetime).toBe("24-hours");
  });
});

describe("a host with trouble", () => {
  it("writes no file until what an earlier host left is gone, and keeps trying", async () => {
    const real = createThreadSecretFiles({ root });
    let stuck = true;
    const context = host({
      files: {
        ...real,
        sweep: () => {
          if (stuck) throw new Error("A file is in use.");
          real.sweep();
        },
      },
    });
    expect(await grant(context)).toMatchObject({ delivery: "environment" });
    stuck = false;
    context.service.sweep();
    context.service.withdrawThread(THREAD);
    expect(await grant(context)).toMatchObject({ delivery: "file-and-environment" });
  });

  it("ends every secret although stopping one value's redaction fails", async () => {
    const context = host({
      hold: () => () => {
        throw new Error("Not released.");
      },
    });
    await grant(context, request({ name: "ONE" }));
    await grant(context, request({ name: "TWO" }));
    context.service.withdrawThread(THREAD);
    expect(context.service.active()).toEqual([]);
    expect(records().filter((record) => record.name === "thread-secret.revoked")).toHaveLength(2);
  });

  it("refuses a use it cannot redact, and records none", async () => {
    let fails = false;
    const context = host({
      hold: () => {
        if (fails) throw new Error("Not held.");
        return () => undefined;
      },
    });
    context.service.registerConsumer(CONSUMER);
    const result = await grant(context, request({ delivery: "handle" }));
    if (result.status !== "saved" || !("handle" in result)) throw new Error("No handle.");
    fails = true;
    expect(
      await context.service.redeem({
        consumerId: CONSUMER.id,
        caller: context.caller,
        handle: result.handle,
        signal: new AbortController().signal,
      }),
    ).toEqual({ status: "refused", failure: "unavailable" });
    expect(records().some((record) => record.name === "thread-secret.used")).toBe(false);
  });

  it("masks every field of an account password, whatever the agent asked", () => {
    const context = host();
    const fields = [
      { name: "USER", label: "User", secret: false },
      { name: "PASSWORD", label: "Password", secret: false },
    ];
    void context.service.request(context.caller, request({ kind: "account-password", fields }));
    expect(card(context.service).fields.map(({ secret }) => secret)).toEqual([true, true]);
  });

  it("shows a card whose field has a name Windows keeps for itself", async () => {
    const context = host();
    const fields = [{ name: "AUX", label: "Auxiliary key" }];
    const asked = context.service.request(context.caller, request({ fields }));
    const view = JSON.parse(JSON.stringify(context.service.view(WINDOW, THREAD)));
    expect(decodeThreadSecretsView(view).requests).toMatchObject([{ fields: [{ name: "AUX" }] }]);
    expect(
      decodeThreadSecretAnswer({
        id: card(context.service).id,
        action: "save",
        lifetime: "1-hour",
        fields: [{ name: "AUX", source: "pasted", value: VALUE }],
      }),
    ).toMatchObject({ fields: [{ name: "AUX" }] });
    expect(await save(context.service)).toEqual({ status: "accepted" });
    expect(await asked).toMatchObject({ status: "saved" });
  });

  it("keeps the earlier secret and its file when the new file cannot be put in place", async () => {
    const real = createThreadSecretFiles({ root });
    let full = false;
    const context = host({
      files: {
        ...real,
        prepare: (...input) => {
          const prepared = real.prepare(...input);
          return {
            ...prepared,
            commit: () => {
              prepared.commit();
              if (full) throw new Error("The disk is full.");
            },
          };
        },
      },
    });
    await grant(context);
    const [before] = context.service.active();
    full = true;
    void context.service.request(context.caller, request({ kind: "account-password" }));
    expect(await save(context.service, { value: "second-Value-1" })).toMatchObject({
      status: "refused",
    });
    expect(context.service.active()).toMatchObject([{ id: before?.id }]);
    expect(readFileSync(join(root, THREAD, "DEPLOY_TOKEN"), "utf8")).toBe(VALUE);
    expect(redactHostSecrets(`${VALUE} second-Value-1`)).toBe("[redacted secret] second-Value-1");
    expect(records().at(-1)).toMatchObject({ cause: "delivery-failed" });
  });
});

describe("the end of a secret", () => {
  const file = () => join(root, THREAD, "DEPLOY_TOKEN");
  const ended = (context: ReturnType<typeof host>) => {
    expect(existsSync(file())).toBe(false);
    expect(context.service.active()).toEqual([]);
  };

  it.each([
    ["1-hour", 60 * 60_000],
    ["24-hours", 24 * 60 * 60_000],
  ] as const)("comes when %s is up and not before", async (lifetime, duration) => {
    const context = host();
    await grant(context, request(), { lifetime });
    expect(redactHostSecrets(VALUE)).toBe("[redacted secret]");
    context.state.now += duration - 1;
    expect(context.service.active()).toMatchObject([{ remainingMs: 1 }]);
    context.service.sweep();
    expect(existsSync(file())).toBe(true);
    context.state.now += 1;
    context.service.sweep();
    ended(context);
    expect(redactHostSecrets(VALUE)).toBe("[redacted secret]");
    expect(records().at(-1)).toMatchObject({ name: "thread-secret.expired" });
  });

  it.each([
    ["the person revokes it", "person"],
    ["its thread is archived", "thread-archived"],
    ["the host stops", "host-stopped"],
  ] as const)("comes when %s", async (_name, cause) => {
    const context = host();
    await grant(context, request(), { lifetime: "until-archived" });
    const [secret] = context.service.active(THREAD);
    if (cause === "person") {
      expect(context.service.revoke(OTHER_THREAD, secret?.id ?? "")).toEqual({ status: "gone" });
      expect(context.service.revoke(THREAD, secret?.id ?? "")).toEqual({ status: "accepted" });
    } else if (cause === "thread-archived") context.service.withdrawThread(THREAD);
    else context.service.close();
    ended(context);
    expect(records().at(-1)).toMatchObject({ name: "thread-secret.revoked", cause });
    // The token usually still works, so only the host's stop ends its redaction.
    expect(redactHostSecrets(VALUE)).toBe(cause === "host-stopped" ? VALUE : "[redacted secret]");
    context.service.close();
    expect(redactHostSecrets(VALUE)).toBe(VALUE);
  });

  it("spends none of its redactions on a value that is no secret", async () => {
    const context = host();
    await grant(context);
    context.service.withdrawThread(THREAD);
    for (let round = 0; round < 140; round += 1) {
      await grant(
        context,
        request({ delivery: "handle", fields: [{ name: "EMAIL", label: "Email", secret: false }] }),
        { fields: [{ name: "EMAIL", source: "pasted", value: "person@example.com" }] },
      );
      context.service.withdrawThread(THREAD);
    }
    expect(redactHostSecrets(VALUE)).toBe("[redacted secret]");
  });

  it("keeps only so many ended values redacted", async () => {
    const holds = { live: 0 };
    const context = host({
      hold: () => {
        holds.live += 1;
        return () => (holds.live -= 1);
      },
    });
    for (let round = 0; round < 140; round += 1) {
      await grant(context, request({ delivery: "handle" }));
      context.service.withdrawThread(THREAD);
    }
    expect(holds.live).toBe(128);
    context.service.close();
    expect(holds.live).toBe(0);
  });

  it("comes with its turn, and with no other turn", async () => {
    const context = host();
    await grant(context, request(), { lifetime: "this-turn" });
    context.service.turnEnded(THREAD, "another");
    context.service.turnEnded(OTHER_THREAD, "turn");
    expect(existsSync(file())).toBe(true);
    context.service.turnEnded(THREAD, "turn");
    ended(context);
    expect(redactHostSecrets(VALUE)).toBe("[redacted secret]");
  });

  it("outlasts its turn when the person chose longer", async () => {
    const context = host();
    await grant(context, request(), { lifetime: "1-hour" });
    context.service.turnEnded(THREAD, "turn");
    expect(existsSync(file())).toBe(true);
  });

  it("comes for the earlier secret when its name is asked for again and answered", async () => {
    const context = host();
    await grant(context, request({ delivery: "handle" }));
    await grant(context, request(), { value: "second-Value-1" });
    expect(readFileSync(file(), "utf8")).toBe("second-Value-1");
    expect(context.service.active()).toHaveLength(1);
    expect(redactHostSecrets(`${VALUE} second-Value-1`)).toBe(
      "[redacted secret] [redacted secret]",
    );
    expect(records()).toMatchObject([
      { name: "thread-secret.granted" },
      { name: "thread-secret.granted" },
      { name: "thread-secret.revoked", cause: "replaced" },
    ]);
  });

  it("is completed by the next start when a host died holding it", async () => {
    const first = host();
    await grant(first, request(), { lifetime: "24-hours" });
    // A crash: no close, and the file still there.
    expect(existsSync(file())).toBe(true);
    const second = host();
    expect(existsSync(file())).toBe(false);
    expect(second.service.active()).toEqual([]);
    expect(records().at(-1)).toMatchObject({
      name: "thread-secret.revoked",
      cause: "host-stopped",
    });
    host();
    expect(records().filter((record) => record.name === "thread-secret.revoked")).toHaveLength(1);
  });

  it("still ends the secret when the journal refuses the record", async () => {
    let fails = false;
    const context = host({ journalFails: () => fails });
    await grant(context, request(), { lifetime: "1-hour" });
    fails = true;
    context.state.now += 60 * 60_000;
    context.service.sweep();
    ended(context);
  });

  it("keeps trying to remove a file, and leaves a newer one of the same name alone", async () => {
    const real = createThreadSecretFiles({ root });
    let stuck = true;
    const context = host({
      files: {
        ...real,
        remove: (threadId, name) => {
          if (stuck) throw new Error("The file is in use.");
          real.remove(threadId, name);
        },
      },
    });
    await grant(context, request(), { lifetime: "this-turn" });
    context.service.turnEnded(THREAD, "turn");
    expect(existsSync(file())).toBe(true);
    await grant(context, request(), { value: "second-Value-1" });
    stuck = false;
    context.service.sweep();
    expect(readFileSync(file(), "utf8")).toBe("second-Value-1");
    stuck = true;
    context.service.withdrawThread(THREAD);
    stuck = false;
    context.service.sweep();
    expect(existsSync(file())).toBe(false);
  });
});

describe("a grant that cannot be completed", () => {
  it("leaves no file, value or redaction when the journal refuses it", async () => {
    const context = host({ journalFails: () => true });
    const asked = context.service.request(context.caller, request());
    expect(await save(context.service)).toEqual({ status: "refused", failure: "unavailable" });
    expect(existsSync(join(root, THREAD, "DEPLOY_TOKEN"))).toBe(false);
    expect(existsSync(join(root, THREAD, "DEPLOY_TOKEN.partial"))).toBe(false);
    expect(context.service.active()).toEqual([]);
    expect(redactHostSecrets(VALUE)).toBe(VALUE);
    expect(card(context.service).state).toBe("pending");
    context.stop.abort();
    expect(await asked).toMatchObject({ status: "cancelled" });
  });

  it("keeps the earlier secret when the journal refuses its replacement", async () => {
    let fails = false;
    const context = host({ journalFails: () => fails });
    await grant(context, request({ delivery: "handle" }));
    const [before] = context.service.active();
    void context.service.request(context.caller, request());
    fails = true;
    expect(await save(context.service, { value: "second-Value-1" })).toMatchObject({
      status: "refused",
    });
    expect(context.service.active()).toEqual([before]);
    expect(redactHostSecrets(`${VALUE} second-Value-1`)).toBe("[redacted secret] second-Value-1");
  });

  it("leaves no redaction when its handle cannot be issued", async () => {
    let calls = 0;
    const context = host({
      // The card, the secret, then its handle.
      uuid: () => {
        calls += 1;
        if (calls === 3) throw new Error("No more names.");
        return crypto.randomUUID();
      },
    });
    void context.service.request(context.caller, request({ delivery: "handle" }));
    expect(await save(context.service)).toEqual({ status: "refused", failure: "unavailable" });
    expect(context.service.active()).toEqual([]);
    expect(redactHostSecrets(VALUE)).toBe(VALUE);
    expect(records().at(-1)).toMatchObject({ cause: "delivery-failed" });
  });

  it("is recorded as ended when its file cannot be put in place", async () => {
    const real = createThreadSecretFiles({ root });
    const context = host({
      files: {
        ...real,
        prepare: (...input) => ({
          ...real.prepare(...input),
          commit: () => {
            throw new Error("The disk is full.");
          },
        }),
      },
    });
    void context.service.request(context.caller, request());
    expect(await save(context.service)).toEqual({ status: "refused", failure: "unavailable" });
    expect(existsSync(join(root, THREAD, "DEPLOY_TOKEN.partial"))).toBe(false);
    expect(redactHostSecrets(VALUE)).toBe(VALUE);
    expect(records()).toMatchObject([
      { name: "thread-secret.granted" },
      { name: "thread-secret.revoked", cause: "delivery-failed" },
    ]);
  });
});
