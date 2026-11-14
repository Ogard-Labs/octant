import { Schema } from "effect";
import { HostId } from "./host";
import { ProjectId } from "./projects";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/** POSIX host paths only. Other platforms must refuse before interpreting them. */
export const SandboxPolicyPath = Schema.String.pipe(
  Schema.maxLength(4096),
  Schema.filter(
    (path) =>
      path.startsWith("/") &&
      path !== "/" &&
      Array.from(path).every(
        (character) =>
          character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127 && character !== "\\",
      ) &&
      path
        .split("/")
        .slice(1)
        .every((part) => part !== "" && part !== "." && part !== ".."),
  ),
);

const roots = Schema.Array(SandboxPolicyPath).pipe(Schema.maxItems(64));

/**
 * A complete selection, supplied only by the host's trusted launch planner.
 * This contract is not an agent tool or a repository configuration format.
 * Existing settings remain unchanged until a planner explicitly selects one.
 * Revisions distinguish a revoked and subsequently re-created grant.
 */
export const SandboxPolicy = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  revision: Schema.Number.pipe(Schema.int(), Schema.between(0, Number.MAX_SAFE_INTEGER)),
  filesystem: Schema.Struct({
    readOnlyRoots: roots,
    readWriteRoots: roots,
    protectedPaths: Schema.Array(
      Schema.Struct({
        path: SandboxPolicyPath,
        mode: Schema.Literal("read-only", "deny"),
      }).annotations(strict),
    ).pipe(Schema.maxItems(256)),
  }).annotations(strict),
  network: Schema.Literal("existing-policy", "deny", "unrestricted"),
  credentials: Schema.Literal("existing-policy", "isolated"),
  hostServices: Schema.Literal("existing-policy", "blocked"),
}).annotations(strict);
export type SandboxPolicy = typeof SandboxPolicy.Type;

export const decodeSandboxPolicy = Schema.decodeUnknownSync(SandboxPolicy);

const identity = Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(256));

/** Session identity includes a fresh host-process epoch; temporary grants never resume after restart. */
export const SandboxPolicyContext = Schema.Struct({
  hostId: HostId,
  projectId: ProjectId,
  checkoutId: identity.pipe(Schema.brand("SandboxCheckoutIdentity")),
  sessionId: identity.pipe(Schema.brand("SandboxSessionIdentity")),
  provider: identity,
}).annotations(strict);
export type SandboxPolicyContext = typeof SandboxPolicyContext.Type;

export const SandboxPolicySelection = Schema.Struct({
  policy: SandboxPolicy,
  context: SandboxPolicyContext,
}).annotations(strict);
export type SandboxPolicySelection = typeof SandboxPolicySelection.Type;
export const decodeSandboxPolicySelection = Schema.decodeUnknownSync(SandboxPolicySelection);
