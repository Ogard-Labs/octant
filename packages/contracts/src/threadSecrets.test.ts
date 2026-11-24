import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_TOOL_OPERATIONS,
  OCTANT_CREDENTIAL_TOOL,
  OCTANT_CREDENTIAL_TOOL_WITHOUT_SECRETS,
} from "./credentialRequest";
import {
  ActiveThreadSecret,
  ThreadSecretAnswer,
  ThreadSecretJournalRecord,
  ThreadSecretRequestCard,
  ThreadSecretRequestInput,
  ThreadSecretRequestResult,
  ThreadSecretRunInput,
} from "./threadSecrets";

const ID = "00000000-0000-4000-8000-000000000001";
const OTHER_ID = "00000000-0000-4000-8000-000000000002";
const WINDOW_ID = "00000000-0000-4000-8000-000000000003";

const input = {
  operation: "request-secret",
  name: "DEPLOY_TOKEN",
  label: "Deploy token",
  kind: "token",
  reason: "Publish the preview build.",
} as const;

describe("what an agent may ask for", () => {
  const decode = Schema.decodeUnknownSync(ThreadSecretRequestInput);

  it("accepts a request that names only what it needs", () => {
    expect(decode(input)).toEqual(input);
  });

  it.each([
    "",
    "deploy_token",
    "1TOKEN",
    "_TOKEN",
    "DEPLOY-TOKEN",
    "../TOKEN",
    "A".repeat(65),
    "CON",
    "NUL",
    "COM1",
  ])("refuses %j as a name that becomes a file and a variable", (name) => {
    expect(() => decode({ ...input, name })).toThrow();
  });

  it.each(["https://example.com/tokens", "http://127.0.0.1:8080/setup"])(
    "accepts the setup page %s",
    (url) => {
      expect(decode({ ...input, url }).url).toBe(url);
    },
  );

  it.each([
    "javascript:alert(1)",
    "file:///etc/passwd",
    "data:text/html,hi",
    "op://Private/Item/field",
    "example.com/tokens",
    "https://user:password@example.com/",
    "",
  ])("refuses %j as a setup page", (url) => {
    expect(() => decode({ ...input, url })).toThrow();
  });

  it.each([
    "https://git\thub.com.evil.example/",
    "https://evil.example\\@github.com/settings",
    "https://example.com/\u202egnp.exe",
    "https://example.com/a b",
  ])("refuses %j, which does not go where it reads", (url) => {
    expect(() => decode({ ...input, url })).toThrow();
  });

  it.each([
    ["label", "Token \u202e txt"],
    ["label", "\u200b\u2800"],
    ["label", "\u3164"],
    ["label", "a\u00a0b"],
    ["label", "Token\nOctant: approved"],
    ["reason", "Publish.\n\nOctant has verified this request."],
    ["reason", "Publish\u0000"],
    ["placeholder", "\u001b[31mred"],
  ])("refuses a %s of %j, which a person cannot read as it is", (key, value) => {
    expect(() => decode({ ...input, [key]: value })).toThrow();
  });

  it("accepts a label in another script", () => {
    expect(decode({ ...input, label: "デプロイ用トークン" }).label).toBe("デプロイ用トークン");
  });

  const field = (index: number) => ({ name: `FIELD_${index}`, label: `Field ${index}` });

  it("accepts one to eight named fields, some of them shown as typed", () => {
    const fields = [
      { name: "EMAIL", label: "Email", placeholder: "you@example.com", secret: false },
      ...Array.from({ length: 7 }, (_, index) => field(index)),
    ];
    expect(decode({ ...input, fields }).fields).toHaveLength(8);
  });

  it("refuses no fields, a ninth field, and two fields with one name", () => {
    expect(() => decode({ ...input, fields: [] })).toThrow();
    expect(() =>
      decode({ ...input, fields: Array.from({ length: 9 }, (_, index) => field(index)) }),
    ).toThrow();
    expect(() => decode({ ...input, fields: [field(1), field(1)] })).toThrow();
  });

  it("keeps the spaces in a value pasted in chat", () => {
    expect(decode({ ...input, value: "  two words  " }).value).toBe("  two words  ");
  });

  it("refuses a pasted value with fields, an empty one, and one no variable can carry", () => {
    expect(() => decode({ ...input, value: "private", fields: [field(1)] })).toThrow();
    expect(() => decode({ ...input, value: "" })).toThrow();
    expect(() => decode({ ...input, value: "a\u0000b" })).toThrow();
  });

  it("refuses a lifetime or a 1Password reference chosen by the agent", () => {
    expect(() => decode({ ...input, lifetime: "remember" })).toThrow();
    expect(() => decode({ ...input, reference: "op://Private/Item/field" })).toThrow();
  });
});

describe("a command run with a secret", () => {
  const decode = Schema.decodeUnknownSync(ThreadSecretRunInput);
  const run = { operation: "run-with-secret", command: "deploy", secrets: ["DEPLOY_TOKEN"] };

  it("names the secrets it is given and never carries one", () => {
    expect(decode(run)).toEqual(run);
    expect(decode({ ...run, secrets: ["SERVICE_TOKEN", "A"] }).secrets).toHaveLength(2);
    expect(() => decode({ ...run, environment: { TOKEN: "private" } })).toThrow();
    expect(() => decode({ ...run, value: "private" })).toThrow();
  });

  it("refuses no command, no secret, a repeated one, and a name that is not one", () => {
    for (const over of [
      { command: "  " },
      { command: "a\u0000b" },
      { command: "x".repeat(1_501) },
      { secrets: [] },
      { secrets: ["A", "A"] },
      { secrets: ["PATH; rm"] },
      { secrets: ["A", "B", "C", "D", "E", "F", "G", "H", "I"] },
      { timeoutMs: 0 },
    ])
      expect(() => decode({ ...run, ...over })).toThrow();
  });
});

describe("what the agent gets back", () => {
  const decode = Schema.decodeUnknownSync(ThreadSecretRequestResult);

  it.each([
    { status: "saved", delivery: "handle", name: "DEPLOY_TOKEN", handle: ID },
    {
      status: "saved",
      delivery: "handle",
      name: "SERVICE",
      handles: { EMAIL: ID, TOKEN: OTHER_ID },
    },
    {
      status: "saved",
      delivery: "file-and-environment",
      name: "DEPLOY_TOKEN",
      file: "/private/tmp/runtime/thread-secrets/thread/DEPLOY_TOKEN",
      env: "OCTANT_SECRET_DEPLOY_TOKEN",
    },
    {
      status: "saved",
      delivery: "file-and-environment",
      name: "SERVICE",
      files: { EMAIL: "/secrets/SERVICE_EMAIL", TOKEN: "/secrets/SERVICE_TOKEN" },
      env: { EMAIL: "OCTANT_SECRET_SERVICE_EMAIL", TOKEN: "OCTANT_SECRET_SERVICE_TOKEN" },
    },
    {
      status: "saved",
      delivery: "environment",
      name: "DEPLOY_TOKEN",
      env: "OCTANT_SECRET_DEPLOY_TOKEN",
    },
    {
      status: "saved",
      delivery: "each-use",
      name: "DEPLOY_TOKEN",
      env: "OCTANT_SECRET_DEPLOY_TOKEN",
    },
    { status: "declined", note: "The person declined. Do not ask again." },
    { status: "cancelled", note: "The turn stopped before an answer." },
    { status: "refused", failure: "unsupported-mode", note: "Chat runs no commands." },
  ])("accepts $status $delivery", (result) => {
    expect(decode(result)).toEqual(result);
  });

  it("refuses a value beside any result", () => {
    const results = [
      { status: "saved", delivery: "handle", name: "DEPLOY_TOKEN", handle: ID },
      { status: "saved", delivery: "environment", name: "A", env: "OCTANT_SECRET_A" },
      { status: "declined", note: "Declined." },
    ];
    for (const result of results) {
      expect(() => decode({ ...result, value: "private" })).toThrow();
      expect(() => decode({ ...result, secret: "private" })).toThrow();
    }
  });

  it("refuses a file path when the value reaches commands only as a variable", () => {
    for (const delivery of ["environment", "each-use"])
      expect(() =>
        decode({ status: "saved", delivery, name: "A", env: "OCTANT_SECRET_A", file: "/a" }),
      ).toThrow();
  });
});

describe("the card and its private answer", () => {
  const card = {
    id: ID,
    threadId: "thread",
    name: "SERVICE",
    label: "Service sign-in",
    kind: "token",
    reason: "Read the test account.",
    delivery: "handle",
    fields: [
      { name: "EMAIL", label: "Email", secret: false },
      { name: "TOKEN", label: "Token", secret: true },
    ],
    lifetimes: ["this-command", "this-turn", "24-hours"],
    defaultLifetime: "24-hours",
    sources: ["pasted", "onepassword"],
    remembered: [],
    state: "pending",
  };
  const decodeCard = Schema.decodeUnknownSync(ThreadSecretRequestCard);
  const decodeAnswer = Schema.decodeUnknownSync(ThreadSecretAnswer);

  it("refuses a value on the card", () => {
    expect(decodeCard(card)).toEqual(card);
    expect(() => decodeCard({ ...card, value: "private" })).toThrow();
    expect(() =>
      decodeCard({ ...card, fields: [{ ...card.fields[1], value: "private" }] }),
    ).toThrow();
  });

  it("carries a link only as the browser will open it", () => {
    const url = "https://xn--pple-43d.com/settings";
    expect(decodeCard({ ...card, url }).url).toBe(url);
    expect(() => decodeCard({ ...card, url: "https://\u0430pple.com/settings" })).toThrow();
  });

  it("refuses a default lifetime the card does not offer", () => {
    expect(() => decodeCard({ ...card, defaultLifetime: "remember" })).toThrow();
  });

  it("takes each field from its own source and keeps the spaces in a typed value", () => {
    const answer = {
      id: ID,
      action: "save",
      lifetime: "24-hours",
      fields: [
        { name: "EMAIL", source: "pasted", value: " you@example.com " },
        {
          name: "TOKEN",
          source: "onepassword",
          store: "onepassword",
          reference: "op://Private/Service/credential",
          freshEachUse: true,
        },
        { name: "PIN", source: "remembered", rememberedId: OTHER_ID },
      ],
    };
    expect(decodeAnswer(answer)).toEqual(answer);
  });

  it("refuses mixed material, a repeated field, and anything beside a decline", () => {
    const save = (fields: ReadonlyArray<unknown>) => ({
      id: ID,
      action: "save",
      lifetime: "this-turn",
      fields,
    });
    const pasted = { name: "TOKEN", source: "pasted", value: "private" };
    expect(() =>
      decodeAnswer(save([{ ...pasted, reference: "op://Private/Service/credential" }])),
    ).toThrow();
    expect(() => decodeAnswer(save([pasted, pasted]))).toThrow();
    expect(() => decodeAnswer(save([]))).toThrow();
    expect(() => decodeAnswer({ id: ID, action: "decline", fields: [pasted] })).toThrow();
  });

  it("shows an active secret without its value", () => {
    const active = {
      id: ID,
      threadId: "thread",
      name: "SERVICE_TOKEN",
      label: "Token",
      kind: "token",
      source: "pasted",
      lifetime: "1-hour",
      delivery: "environment",
      remainingMs: 60_000,
    };
    const decode = Schema.decodeUnknownSync(ActiveThreadSecret);
    expect(decode(active)).toEqual(active);
    expect(() => decode({ ...active, value: "private" })).toThrow();
  });
});

describe("what the journal keeps", () => {
  const decode = Schema.decodeUnknownSync(ThreadSecretJournalRecord);
  const common = {
    secretId: ID,
    threadId: "thread",
    mode: "code",
    secretName: "DEPLOY_TOKEN",
    kind: "token",
  };
  const records = [
    {
      name: "thread-secret.granted",
      ...common,
      source: "pasted",
      lifetime: "24-hours",
      delivery: "file-and-environment",
      windowId: WINDOW_ID,
    },
    { name: "thread-secret.used", ...common, use: "handle" },
    { name: "thread-secret.expired", ...common },
    { name: "thread-secret.revoked", ...common, cause: "person" },
  ];

  it("accepts a grant, a use, an expiry and a revocation as metadata", () => {
    for (const record of records) expect(decode(record)).toEqual(record);
  });

  it("refuses a value, a reference, a path or free text on every record", () => {
    for (const record of records)
      for (const key of ["value", "secret", "reference", "file", "handle", "label", "reason"])
        expect(() => decode({ ...record, [key]: "private" })).toThrow();
  });

  it("refuses a secret recorded for a Chat thread", () => {
    expect(() => decode({ ...records[2], mode: "chat" })).toThrow();
  });
});

describe("what the agent is told", () => {
  it("tells the agent to ask in the card, how to use sudo, and to stop on a decline", () => {
    const { description } = OCTANT_CREDENTIAL_TOOL;
    expect(description).toContain("request-secret");
    expect(description).toContain("Never ask for a secret in chat");
    expect(description).toContain("sudo -n");
    expect(description).toContain(`sudo -S -p '' <cmd> < "$file"`);
    expect(description).toContain("printf");
    expect(description).toContain("declined");
    expect(description).toMatch(/do not ask again/i);
  });

  it("advertises request-secret and its inputs only where the host offers it", () => {
    expect(CREDENTIAL_TOOL_OPERATIONS).toContain("request-secret");
    expect(Object.keys(OCTANT_CREDENTIAL_TOOL.inputSchema.properties)).toEqual([
      "operation",
      "id",
      "name",
      "label",
      "kind",
      "reason",
      "url",
      "placeholder",
      "fields",
      "delivery",
      "value",
      "clientRequestId",
    ]);
    expect(Object.keys(OCTANT_CREDENTIAL_TOOL_WITHOUT_SECRETS.inputSchema.properties)).toEqual([
      "operation",
      "id",
    ]);
    expect(OCTANT_CREDENTIAL_TOOL_WITHOUT_SECRETS.description).not.toContain("request-secret");
  });
});
