import type { ProviderRuntimeEvent } from "@octant/contracts";
import type { ProviderDriver } from "@octant/provider-sdk/driver";
import { Effect, Stream } from "effect";
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
  "tool-progress",
  "tool-success",
  "tool-failure",
  "file-change",
  "diff",
  "task-progress",
  "failed",
]);

export function redactProviderRuntimeEvent(event: ProviderRuntimeEvent): ProviderRuntimeEvent {
  return REDACTED_KINDS.has(event.kind) ? redactHostSecretsInValue(event) : event;
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
