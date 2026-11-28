/** Read-only setup checks. Results describe one probe, never authorize a task or accept SSH trust. */
import { Schema } from "effect";
import { AggregateId } from "./events";
import { ServerFolderPath } from "./serverProjects";

export const RemoteSetupCheckInput = Schema.Struct({
  serverId: AggregateId,
  folder: Schema.optional(ServerFolderPath),
  runtime: Schema.Literals(["octant-harness", "native-provider"]),
});
export type RemoteSetupCheckInput = typeof RemoteSetupCheckInput.Type;

export const RemoteSetupCheckReason = Schema.Literals([
  "ready",
  "needs-person",
  "needs-local-window",
  "server-not-registered",
  "registration-changed",
  "missing-agent",
  "authentication-refused",
  "key-confirmation-required",
  "kept-key-unsupported",
  "unknown-identity",
  "changed-identity",
  "host-unavailable",
  "directory-unavailable",
  "unsupported-runtime",
  "probe-unavailable",
  "cancelled",
  "busy",
]);
export type RemoteSetupCheckReason = typeof RemoteSetupCheckReason.Type;
export const RemoteSetupCheckResult = Schema.Struct({
  status: Schema.Literals(["connected", "disconnected", "stopped"]),
  reason: RemoteSetupCheckReason,
  folder: Schema.optional(ServerFolderPath),
}).check(
  Schema.makeFilter((result) =>
    result.status === "connected"
      ? result.reason === "ready" && result.folder !== undefined
      : result.reason !== "ready" && result.folder === undefined,
  ),
);
export type RemoteSetupCheckResult = typeof RemoteSetupCheckResult.Type;
