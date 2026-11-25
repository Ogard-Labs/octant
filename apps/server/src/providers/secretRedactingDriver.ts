import type { ProviderRuntimeEvent } from "@octant/contracts";
import { ThreadForgeReference } from "@octant/contracts";
import type { ProviderDriver } from "@octant/provider-sdk/driver";
import { Effect, Schema, Stream } from "effect";
import { redactHostSecretsInValue } from "../process/secretRedaction";

/**
 * Redacts known key formats, and every value the credential broker handed
 * out, from a driver's normalized runtime events at the shared driver
 * boundary, at every level. Tool output, assistant text, and tool arguments
 * pass here before any service shows, journals, or exports them, so the
 * transcript, the journal, exports, and diagnostics built from them never
 * carry the secret. An event with nothing to redact passes through as the
 * same object.
 *
 * What it does not cover: a secret split across two streamed text chunks,
 * and anything a runtime shows the model directly. The model still sees what
 * a tool returned; the guard that keeps files out of reach is the OS rule.
 */
/**
 * The kinds that carry what a runtime said or a tool printed. A tool or
 * approval request is left as it is: Octant runs an app tool's input exactly
 * as asked, and redacting it would change what the agent does rather than
 * what is recorded.
 */
const REDACTED_KINDS: ReadonlySet<ProviderRuntimeEvent["kind"]> = new Set([
  "text-delta",
  "reasoning-delta",
  "tool-start",
  "tool-call-content",
  "tool-progress",
  "tool-success",
  "tool-failure",
  "file-change",
  "diff",
  "task-progress",
  "failed",
]);

/** What says which event this is and what state it reports, in Octant's own words. */
const STRUCTURE = [
  "instanceId",
  "sessionId",
  "correlationId",
  "occurredAt",
  "kind",
  "part",
  "change",
  "status",
] as const;

const isForgeReference = Schema.is(ThreadForgeReference);

export function redactProviderRuntimeEvent(event: ProviderRuntimeEvent): ProviderRuntimeEvent {
  if (!REDACTED_KINDS.has(event.kind)) return event;
  const redacted = redactHostSecretsInValue(event);
  if (redacted === event) return event;
  // A password can be a word Octant uses ("completed"). Those stay; anything
  // else that carries it is replaced.
  const structure = STRUCTURE.filter((key) => key in event).map((key) => [
    key,
    Reflect.get(event, key),
  ]);
  const shown = { ...redacted, ...Object.fromEntries(structure) } as ProviderRuntimeEvent;
  if (event.kind === "failed" && shown.kind === "failed") {
    const { category, reason, diagnostic, usageLimit } = event.failure;
    return {
      ...shown,
      failure: {
        ...shown.failure,
        category,
        ...(reason === undefined ? {} : { reason }),
        ...(diagnostic === undefined ? {} : { diagnostic }),
        ...(usageLimit === undefined ? {} : { usageLimit }),
      },
    };
  }
  if (event.kind !== "tool-success" || shown.kind !== "tool-success") return shown;
  const { forgeReferences, ...rest } = shown;
  // A name that carried the secret names nothing once it is replaced.
  const readable = (forgeReferences ?? []).flatMap((reference, index) => {
    const { forge, kind, action } = event.forgeReferences?.[index] ?? reference;
    const kept: unknown = { ...reference, forge, kind, action };
    return isForgeReference(kept) ? [kept] : [];
  });
  return readable.length === 0 ? rest : { ...rest, forgeReferences: readable };
}

export function redactProviderRuntimeSecrets(driver: ProviderDriver): ProviderDriver {
  return {
    ...driver,
    acquire: (input) =>
      driver.acquire(input).pipe(
        Effect.map((connection) => ({
          ...connection,
          subscribe: connection.subscribe.pipe(
            Effect.map((events) => events.pipe(Stream.map(redactProviderRuntimeEvent))),
          ),
        })),
      ),
  };
}
