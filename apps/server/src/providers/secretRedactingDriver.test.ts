import {
  decodeProviderInstanceId,
  decodeProviderRuntimeEvent,
  decodeProviderSessionId,
  type ProviderRuntimeEvent,
} from "@octant/contracts";
import { SECRET_REDACTION } from "@octant/domain/secret-guard-policy";
import type { ProviderDriver } from "@octant/provider-sdk/driver";
import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { noteIssuedSecret } from "../process/secretRedaction";
import { redactProviderRuntimeSecrets } from "./secretRedactingDriver";

const instanceId = decodeProviderInstanceId("00000000-0000-4000-8000-000000000011");
const sessionId = decodeProviderSessionId("00000000-0000-4000-8000-000000000012");
// Fake credentials built at run time.
const fakeGithubToken = `gh${"p"}_${"e".repeat(32)}`;
const fakeIssued = `issued-${"f".repeat(12)}`;

function event(fields: Record<string, unknown>): ProviderRuntimeEvent {
  return decodeProviderRuntimeEvent({
    instanceId,
    sessionId,
    sequence: 1,
    correlationId: "00000000-0000-4000-8000-000000000013",
    occurredAt: "2026-10-31T10:00:00.000Z",
    ...fields,
  });
}

function fixture(events: ReadonlyArray<ProviderRuntimeEvent>): ProviderDriver {
  return {
    kind: "codex",
    probe: () => Effect.fail({ category: "unavailable", message: "not used" }),
    acquire: () =>
      Effect.succeed({
        subscribe: Effect.succeed(Stream.fromIterable(events)),
        start: () => Effect.succeed({ sessionId }),
        resume: () => Effect.succeed({ sessionId }),
        send: () => Effect.void,
        interrupt: () => Effect.void,
        stop: () => Effect.void,
        answerApproval: () => Effect.void,
        answerUserInput: () => Effect.void,
        answerTool: () => Effect.void,
      }),
  } as unknown as ProviderDriver;
}

async function collect(driver: ProviderDriver): Promise<ReadonlyArray<ProviderRuntimeEvent>> {
  const connection = await Effect.runPromise(
    Effect.scoped(driver.acquire({ instanceId, projectRoot: "/tmp/octant-test" })),
  );
  return Array.from(
    await Effect.runPromise(Stream.runCollect(Stream.unwrapScoped(connection.subscribe))),
  );
}

describe("secret redaction at the driver boundary", () => {
  it("redacts known key formats and broker-issued values from what a runtime said or printed", async () => {
    noteIssuedSecret(fakeIssued);
    const events = await collect(
      redactProviderRuntimeSecrets(
        fixture([
          event({ kind: "text-delta", text: `Your token is ${fakeGithubToken}.` }),
          event({ kind: "text-delta", text: `export KEY=${fakeIssued}` }),
          event({ kind: "text-delta", text: "Nothing secret here." }),
        ]),
      ),
    );
    const texts = events.map((item) => (item.kind === "text-delta" ? item.text : ""));
    expect(texts).toEqual([
      `Your token is ${SECRET_REDACTION}.`,
      `export KEY=${SECRET_REDACTION}`,
      "Nothing secret here.",
    ]);
    expect(JSON.stringify(events)).not.toContain(fakeGithubToken);
    expect(JSON.stringify(events)).not.toContain(fakeIssued);
  });

  it("passes an event with nothing to redact through as the same object", async () => {
    const plain = event({ kind: "text-delta", text: "git push origin main" });
    const [only] = await collect(redactProviderRuntimeSecrets(fixture([plain])));
    expect(only).toBe(plain);
  });
});
