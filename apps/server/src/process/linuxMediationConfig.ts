/** Data-only schemas shared by the host, supervisor and separately bundled worker. */
import { BuiltInProtectedFilesId, ProtectedFilesChannel } from "@octant/contracts/protected-files";
import { Schema } from "effect";
import type { ProcessConfinementPrepareInput } from "./seatbeltProfile";
import { LINUX_MEDIATION_PRODUCTION_MAXIMUM_MS } from "./linuxMediationBroker";

export const MEDIATION_CONFIG_BYTES = 262_144;
const path = Schema.String.pipe(
  Schema.check(Schema.isMaxLength(8_192)),
  Schema.check(Schema.makeFilter((value) => value.startsWith("/") && !value.includes("\0"))),
);
const text = Schema.String.pipe(Schema.check(Schema.makeFilter((value) => !value.includes("\0"))));
const optionalPaths = Schema.optionalKey(Schema.Array(path));
const optionalBoolean = Schema.optionalKey(Schema.Boolean);
const port = Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 65_535 })));
const rootIdentity = Schema.Struct({
  path,
  identity: Schema.String.pipe(Schema.check(Schema.isPattern(/^\d+:\d+$/))),
});
const meta = {
  ruleId: Schema.Union([BuiltInProtectedFilesId, Schema.Literal("added")]),
  label: Schema.String,
  channel: ProtectedFilesChannel,
  ownAccountExempt: Schema.Boolean,
};

export const LinuxMediationLaunchConfig: Schema.Codec<ProcessConfinementPrepareInput> =
  Schema.Struct({
    sandboxProviderChannel: optionalBoolean,
    policyBlockHostServices: optionalBoolean,
    policyReadOnlyRoots: optionalPaths,
    policyFolderRoots: optionalPaths,
    executable: path,
    args: Schema.Array(text),
    boundRoot: path,
    temporaryDirectory: path,
    networkEgress: Schema.Union([
      Schema.Literals(["none", "allow"]),
      Schema.Struct({
        kind: Schema.Literal("proxied"),
        endpoint: Schema.Union([
          Schema.Struct({ kind: Schema.Literal("loopback"), port }),
          Schema.Struct({ kind: Schema.Literal("unix-socket"), path }),
        ]),
      }),
    ]),
    recipientAdmission: Schema.optionalKey(Schema.Struct({ digest: text, identity: text })),
    extraBoundRoots: optionalPaths,
    additionalWriteRoots: optionalPaths,
    readRoots: optionalPaths,
    interpreterSearchPath: Schema.optionalKey(text),
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
    ownAccountAccess: Schema.optionalKey(Schema.Literal("none")),
    protectedFiles: Schema.optionalKey(Schema.Literal("provider-sign-ins")),
    extraRules: Schema.optionalKey(Schema.Array(text)),
    terminal: Schema.optionalKey(Schema.Struct({ shellStateDirectory: path })),
    inboundRelay: Schema.optionalKey(Schema.Struct({ socketPath: path, port })),
    loopbackRelayPorts: Schema.optionalKey(Schema.Array(port)),
    serverRelays: Schema.optionalKey(Schema.Array(Schema.Struct({ socketPath: path, port }))),
  });

export const LinuxMediationPolicyConfig = Schema.Struct({
  entries: Schema.Array(
    Schema.Union([
      Schema.Struct({ ...meta, kind: Schema.Literal("path"), path }),
      Schema.Struct({
        ...meta,
        kind: Schema.Literal("names"),
        directory: path,
        name: Schema.String,
        depth: Schema.Number.pipe(
          Schema.check(Schema.isInt()),
          Schema.check(Schema.isBetween({ minimum: 0, maximum: 64 })),
        ),
        except: Schema.optionalKey(Schema.String),
      }),
    ]),
  ).pipe(Schema.check(Schema.isMaxLength(1_024))),
  ownAccountPaths: Schema.Array(path).pipe(Schema.check(Schema.isMaxLength(1_024))),
  sshCompanionDirectory: Schema.optional(path),
  readOnlyRoots: Schema.optionalKey(
    Schema.Array(path).pipe(Schema.check(Schema.isMaxLength(1_024))),
  ),
  protectedPaths: Schema.optionalKey(
    Schema.Array(Schema.Struct({ path, mode: Schema.Literals(["read-only", "deny"]) })).pipe(
      Schema.check(Schema.isMaxLength(1_024)),
    ),
  ),
});

export const LinuxMediationLaunchPinConfig = Schema.Struct({
  helper: path,
  rootIdentities: Schema.Array(rootIdentity).pipe(Schema.check(Schema.isMaxLength(256))),
});
export type LinuxMediationLaunchPinConfig = typeof LinuxMediationLaunchPinConfig.Type;

export const LinuxMediationSecretGuardConfig = Schema.Struct({
  dataDirectory: Schema.optional(path),
  runtimeDirectory: Schema.optional(path),
  choice: Schema.Struct({
    added: Schema.Array(text),
    removed: Schema.Array(BuiltInProtectedFilesId),
  }),
});
export type LinuxMediationSecretGuardConfig = typeof LinuxMediationSecretGuardConfig.Type;

export const LinuxMediationWorkerConfig = Schema.Struct({
  nativeExecutable: path,
  production: Schema.optionalKey(Schema.Boolean),
  maximumMs: Schema.Int.pipe(
    Schema.check(Schema.isBetween({ minimum: 1, maximum: LINUX_MEDIATION_PRODUCTION_MAXIMUM_MS })),
  ),
  inheritStdio: Schema.optionalKey(Schema.Boolean),
  launch: LinuxMediationLaunchConfig,
  launchPin: Schema.optionalKey(LinuxMediationLaunchPinConfig),
  receiptDirectory: path,
  environment: Schema.Record(text, text),
  secretGuard: LinuxMediationSecretGuardConfig,
  policy: LinuxMediationPolicyConfig,
});
export type LinuxMediationWorkerConfig = typeof LinuxMediationWorkerConfig.Type;

export const LinuxMediationSupervisorConfig = Schema.Struct({
  ownerId: Schema.String.pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(256)),
  ),
  maximumMs: Schema.Int.pipe(
    Schema.check(Schema.isBetween({ minimum: 1, maximum: LINUX_MEDIATION_PRODUCTION_MAXIMUM_MS })),
  ),
  receiptDirectory: path,
  workerScript: path,
  nativeExecutable: path,
  launch: LinuxMediationLaunchConfig,
  launchPin: LinuxMediationLaunchPinConfig,
  secretGuard: LinuxMediationSecretGuardConfig,
  policy: LinuxMediationPolicyConfig,
});
export type LinuxMediationSupervisorConfig = typeof LinuxMediationSupervisorConfig.Type;
