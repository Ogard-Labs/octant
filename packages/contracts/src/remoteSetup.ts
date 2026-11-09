/** Read-only setup checks. Results describe one probe, never authorize a task or accept SSH trust. */
import { Schema } from "effect";
import { AggregateId } from "./events";
import { ServerFolderPath } from "./serverProjects";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
export const RemoteSetupCheckInput = Schema.Struct({
  serverId: AggregateId,
  folder: Schema.optional(ServerFolderPath),
  runtime: Schema.Literal("octant-harness", "native-provider"),
}).annotations(strict);
export type RemoteSetupCheckInput = typeof RemoteSetupCheckInput.Type;

export const RemoteSetupCheckReason = Schema.Literal(
  "ready",
  "needs-local-window",
  "server-not-registered",
  "registration-changed",
  "missing-agent",
  "authentication-refused",
  "kept-key-unsupported",
  "unknown-identity",
  "changed-identity",
  "host-unavailable",
  "directory-unavailable",
  "unsupported-runtime",
  "probe-unavailable",
  "cancelled",
  "busy",
);
export type RemoteSetupCheckReason = typeof RemoteSetupCheckReason.Type;
export const RemoteSetupCheckResult = Schema.Struct({
  status: Schema.Literal("connected", "disconnected", "stopped"),
  reason: RemoteSetupCheckReason,
  folder: Schema.optional(ServerFolderPath),
})
  .annotations(strict)
  .pipe(
    Schema.filter((result) =>
      result.status === "connected"
        ? result.reason === "ready" && result.folder !== undefined
        : result.reason !== "ready" && result.folder === undefined,
    ),
  );
export type RemoteSetupCheckResult = typeof RemoteSetupCheckResult.Type;
