/** Data-only schemas shared by the host, supervisor and separately bundled worker. */
import { BuiltInProtectedFilesId, ProtectedFilesChannel } from "@octant/contracts/protected-files";
import { Schema } from "effect";
import type { ProcessConfinementPrepareInput } from "./seatbeltProfile";
import { LINUX_MEDIATION_PRODUCTION_MAXIMUM_MS } from "./linuxMediationBroker";

export const MEDIATION_CONFIG_BYTES = 262_144;
const path = Schema.String.pipe(
  Schema.maxLength(8_192),
  Schema.filter((value) => value.startsWith("/") && !value.includes("\0")),
);
const text = Schema.String.pipe(Schema.filter((value) => !value.includes("\0")));
const optionalPaths = Schema.optionalWith(Schema.Array(path), { exact: true });
const optionalBoolean = Schema.optionalWith(Schema.Boolean, { exact: true });
const port = Schema.Int.pipe(Schema.between(1, 65_535));
const meta = {
  ruleId: Schema.Union(BuiltInProtectedFilesId, Schema.Literal("added")),
  label: Schema.String,
  channel: ProtectedFilesChannel,
  ownAccountExempt: Schema.Boolean,
};

export const LinuxMediationLaunchConfig: Schema.Schema<ProcessConfinementPrepareInput> =
  Schema.Struct({
    sandboxProviderChannel: optionalBoolean,
    policyBlockHostServices: optionalBoolean,
    policyReadOnlyRoots: optionalPaths,
    policyFolderRoots: optionalPaths,
    executable: path,
    args: Schema.Array(text),
    boundRoot: path,
    temporaryDirectory: path,
    networkEgress: Schema.Union(
      Schema.Literal("none", "allow"),
      Schema.Struct({
        kind: Schema.Literal("proxied"),
        endpoint: Schema.Union(
          Schema.Struct({ kind: Schema.Literal("loopback"), port }),
          Schema.Struct({ kind: Schema.Literal("unix-socket"), path }),
        ),
      }),
    ),
    recipientAdmission: Schema.optionalWith(Schema.Struct({ digest: text, identity: text }), {
      exact: true,
    }),
    extraBoundRoots: optionalPaths,
    additionalWriteRoots: optionalPaths,
    readRoots: optionalPaths,
    interpreterSearchPath: Schema.optionalWith(text, { exact: true }),
    allowProcessExec: optionalBoolean,
    allowProcessFork: optionalBoolean,
    startsNestedCapsules: optionalBoolean,
    allowFileReadStar: optionalBoolean,
    writeBoundRoot: optionalBoolean,
    allowSimulatorControl: optionalBoolean,
    refuseNewSession: optionalBoolean,
    additionalDenyReadPaths: optionalPaths,
    additionalDenyWritePaths: optionalPaths,
    isolatedRoots: optionalPaths,
    privateHomeAllowPaths: optionalPaths,
    ownAccountPaths: optionalPaths,
    ownAccountAccess: Schema.optionalWith(Schema.Literal("none"), {
      exact: true,
    }),
    protectedFiles: Schema.optionalWith(Schema.Literal("provider-sign-ins"), {
      exact: true,
    }),
    extraRules: Schema.optionalWith(Schema.Array(text), { exact: true }),
    terminal: Schema.optionalWith(Schema.Struct({ shellStateDirectory: path }), { exact: true }),
    inboundRelay: Schema.optionalWith(Schema.Struct({ socketPath: path, port }), { exact: true }),
    loopbackRelayPorts: Schema.optionalWith(Schema.Array(port), {
      exact: true,
    }),
    serverRelays: Schema.optionalWith(Schema.Array(Schema.Struct({ socketPath: path, port })), {
      exact: true,
    }),
  });

export const LinuxMediationPolicyConfig = Schema.Struct({
  entries: Schema.Array(
    Schema.Union(
      Schema.Struct({ ...meta, kind: Schema.Literal("path"), path }),
      Schema.Struct({
        ...meta,
        kind: Schema.Literal("names"),
        directory: path,
        name: Schema.String,
        depth: Schema.Number.pipe(Schema.int(), Schema.between(0, 64)),
        except: Schema.optionalWith(Schema.String, { exact: true }),
      }),
    ),
  ).pipe(Schema.maxItems(1_024)),
  ownAccountPaths: Schema.Array(path).pipe(Schema.maxItems(1_024)),
  sshCompanionDirectory: Schema.optional(path),
  readOnlyRoots: Schema.optionalWith(Schema.Array(path).pipe(Schema.maxItems(1_024)), {
    exact: true,
  }),
  protectedPaths: Schema.optionalWith(
    Schema.Array(Schema.Struct({ path, mode: Schema.Literal("read-only", "deny") })).pipe(
      Schema.maxItems(1_024),
    ),
    { exact: true },
  ),
});

export const LinuxMediationWorkerConfig = Schema.Struct({
  nativeExecutable: path,
  production: Schema.optionalWith(Schema.Boolean, { exact: true }),
  maximumMs: Schema.Int.pipe(Schema.between(1, LINUX_MEDIATION_PRODUCTION_MAXIMUM_MS)),
  inheritStdio: Schema.optionalWith(Schema.Boolean, { exact: true }),
  launch: LinuxMediationLaunchConfig,
  receiptDirectory: path,
  environment: Schema.Record({ key: text, value: text }),
  secretGuard: Schema.Struct({
    dataDirectory: Schema.optional(path),
    runtimeDirectory: Schema.optional(path),
    choice: Schema.Struct({
      added: Schema.Array(text),
      removed: Schema.Array(BuiltInProtectedFilesId),
    }),
  }),
  policy: LinuxMediationPolicyConfig,
});
export type LinuxMediationWorkerConfig = typeof LinuxMediationWorkerConfig.Type;

export const LinuxMediationSupervisorConfig = Schema.Struct({
  ownerId: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(256)),
  maximumMs: Schema.Int.pipe(Schema.between(1, LINUX_MEDIATION_PRODUCTION_MAXIMUM_MS)),
  receiptDirectory: path,
  workerScript: path,
  nativeExecutable: path,
  launch: LinuxMediationLaunchConfig,
  policy: LinuxMediationPolicyConfig,
});
export type LinuxMediationSupervisorConfig = typeof LinuxMediationSupervisorConfig.Type;
