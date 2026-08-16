import { lstat } from "node:fs/promises";
import {
  boundHostRuntimeDiagnostics,
  deriveHostServiceState,
  requestHostRuntimeControl,
  ServicePolicyStore,
  type HostRuntimeControlResponse,
  type HostRuntimeDiagnostics,
  type HostRuntimeLocalControlRequest,
  type HostRuntimePaths,
  type HostServicePolicy,
  type HostServiceStateName,
  type HostLogReadOptions,
  type HostLogReadResult,
} from "@octant/host-runtime";
import {
  createUserServiceManager,
  ServiceManagerError,
  type UserServiceManager,
  type UserServiceStatus,
} from "./serviceManager";

export type { UserServiceManager } from "./serviceManager";

export type ServerLifecycleAction =
  | "start"
  | "stop"
  | "restart"
  | "status"
  | "enable"
  | "disable"
  | "logs";

export interface HostLifecycleControl {
  request(request: HostRuntimeLocalControlRequest): Promise<HostRuntimeControlResponse | undefined>;
  proveNoOwner?(): Promise<boolean>;
}

export interface ServerLifecycleDependencies {
  readonly action: ServerLifecycleAction;
  readonly policyStore?: ServicePolicyStore;
  readonly serviceManager?: UserServiceManager;
  readonly control?: HostLifecycleControl;
  readonly paths?: HostRuntimePaths;
  readonly logs?: HostLogReadOptions;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly signal?: AbortSignal;
  readonly stdout?: { write: (chunk: string) => unknown };
}

export interface ServerLifecycleReport {
  readonly state: HostServiceStateName;
  readonly policy: HostServicePolicy;
  readonly manager: UserServiceStatus;
  readonly diagnostics?: HostRuntimeDiagnostics;
  readonly logs?: HostLogReadResult;
  readonly message: string;
}

export async function runServerLifecycleCommand(
  dependencies: ServerLifecycleDependencies,
): Promise<ServerLifecycleReport> {
  const policyStore = dependencies.policyStore ?? defaultPolicyStore(dependencies.paths);
  const serviceManager = dependencies.serviceManager ?? defaultServiceManager(dependencies.paths);
  const control = dependencies.control ?? defaultControl(dependencies.paths);
  const policy = await policyStore.read();
  try {
    return await executeServerLifecycleCommand({
      dependencies,
      policy,
      policyStore,
      serviceManager,
      control,
    });
  } catch (error) {
    if (
      error instanceof ServiceManagerError &&
      (error.code === "manager-unavailable" || error.code === "manager-failed")
    ) {
      return writeReport(
        {
          state: "manager-unavailable",
          policy,
          manager: unavailableManagerStatus(serviceManager.kind),
          message: messageFor("manager-unavailable"),
        },
        dependencies.stdout,
      );
    }
    throw error;
  }
}

async function executeServerLifecycleCommand(input: {
  readonly dependencies: ServerLifecycleDependencies;
  readonly policy: HostServicePolicy;
  readonly policyStore: ServicePolicyStore;
  readonly serviceManager: UserServiceManager;
  readonly control: HostLifecycleControl;
}): Promise<ServerLifecycleReport> {
  const { dependencies, policy, policyStore, serviceManager, control } = input;

  if (dependencies.action === "logs") {
    if (dependencies.logs?.follow === true) {
      return followServerLogs({
        dependencies,
        policy,
        serviceManager,
        control,
      });
    }
    const logs = await readLogs(serviceManager, control, dependencies.logs);
    const report = await buildReport({ policy, serviceManager, control, logs });
    return writeReport(report, dependencies.stdout);
  }

  if (dependencies.action === "status") {
    const report = await buildReport({ policy, serviceManager, control });
    return writeReport(report, dependencies.stdout);
  }

  if (dependencies.action === "enable") {
    await serviceManager.install();
    await serviceManager.enable();
    const nextPolicy = await policyStore.setEnabled(true);
    const report = await buildReport({ policy: nextPolicy, serviceManager, control });
    return writeReport(report, dependencies.stdout);
  }

  if (dependencies.action === "disable") {
    const stopAccepted = await requestStop(control, serviceManager, dependencies.sleep);
    if (stopAccepted === "rejected") {
      const manager = await serviceManager.status();
      const report = await buildReport({ policy, serviceManager, manager, control });
      return writeReport(
        { ...report, state: "unauthorized", message: messageFor("unauthorized") },
        dependencies.stdout,
      );
    }
    const nextPolicy = await policyStore.setEnabled(false);
    await serviceManager.disable();
    const managerBeforeStop = await serviceManager.status();
    if (managerBeforeStop.active) await serviceManager.stop();
    const manager = await serviceManager.status();
    const report = await buildReport({ policy: nextPolicy, serviceManager, manager, control });
    return writeReport(
      { ...report, state: "disabled", message: messageFor("disabled") },
      dependencies.stdout,
    );
  }

  if (dependencies.action === "stop") {
    const stopAccepted = await requestStop(control, serviceManager, dependencies.sleep);
    if (stopAccepted === "rejected") {
      const manager = await serviceManager.status();
      const report = await buildReport({ policy, serviceManager, manager, control });
      return writeReport(
        { ...report, state: "unauthorized", message: messageFor("unauthorized") },
        dependencies.stdout,
      );
    }
    const managerBeforeStop = await serviceManager.status();
    if (managerBeforeStop.active) await serviceManager.stop();
    const manager = managerBeforeStop.active ? await serviceManager.status() : managerBeforeStop;
    const report = await buildReport({ policy, serviceManager, manager, control });
    return writeReport(
      { ...report, state: "stopped", message: messageFor("stopped") },
      dependencies.stdout,
    );
  }

  if (dependencies.action === "restart") {
    const stopAccepted = await requestStop(control, serviceManager, dependencies.sleep);
    if (stopAccepted === "rejected") {
      const manager = await serviceManager.status();
      const report = await buildReport({ policy, serviceManager, manager, control });
      return writeReport(
        { ...report, state: "unauthorized", message: messageFor("unauthorized") },
        dependencies.stdout,
      );
    }
    const manager = await serviceManager.status();
    if (manager.active) await serviceManager.stop();
  }

  await serviceManager.install();
  await serviceManager.start();
  const readiness = await waitForReady(control, dependencies.sleep);
  const report = await buildReport({
    policy,
    serviceManager,
    control,
    requireReadyDiagnostics: true,
    ...(readiness.response === undefined ? {} : { ownerResponse: readiness.response }),
    ...(readiness.diagnostics === undefined ? {} : { readinessDiagnostics: readiness.diagnostics }),
  });
  return writeReport(report, dependencies.stdout);
}

export function createLocalHostLifecycleControl(paths: HostRuntimePaths): HostLifecycleControl {
  return {
    request: (request) => requestHostRuntimeControl(paths, request),
    proveNoOwner: () => proveNoOwner(paths),
  };
}

async function buildReport(input: {
  readonly policy: HostServicePolicy;
  readonly serviceManager: UserServiceManager;
  readonly manager?: UserServiceStatus;
  readonly control: HostLifecycleControl;
  readonly ownerResponse?: HostRuntimeControlResponse;
  readonly readinessDiagnostics?: HostRuntimeDiagnostics;
  readonly requireReadyDiagnostics?: boolean;
  readonly logs?: HostLogReadResult;
}): Promise<ServerLifecycleReport> {
  const manager = input.manager ?? (await input.serviceManager.status());
  const ownerResponse =
    input.ownerResponse ?? (await input.control.request({ type: "status", principal: "local" }));
  const diagnosticsResponse =
    input.readinessDiagnostics === undefined
      ? await input.control.request({
          type: "diagnostics",
          principal: "local",
        })
      : undefined;
  let diagnostics = input.readinessDiagnostics ?? diagnosticsResponse?.diagnostics;
  if (diagnostics === undefined && !input.requireReadyDiagnostics) {
    diagnostics = input.ownerResponse?.diagnostics;
  }
  if (
    diagnostics === undefined &&
    !input.requireReadyDiagnostics &&
    ownerResponse?.owner !== undefined
  ) {
    diagnostics = diagnosticsFromOwner(ownerResponse.owner);
  }
  const stateInput = {
    enabled: input.policy.enabled,
    manager: "available" as const,
    owner:
      input.manager?.ownerState ??
      ownerObservation(
        ownerResponse,
        diagnostics,
        input.manager?.active === true,
        input.requireReadyDiagnostics === true,
      ),
    crashLoop: manager.crashLoop === true || (manager.restartFailures ?? 0) >= 5,
  };
  const state = deriveHostServiceState(stateInput);
  return {
    state: state.state,
    policy: input.policy,
    manager,
    ...(diagnostics === undefined ? {} : { diagnostics: boundHostRuntimeDiagnostics(diagnostics) }),
    ...(input.logs === undefined ? {} : { logs: input.logs }),
    message: messageFor(state.state),
  };
}

function unavailableManagerStatus(kind: UserServiceManager["kind"]): UserServiceStatus {
  return {
    kind,
    installed: false,
    enabled: false,
    active: false,
    session: "unknown",
    lingering: "unknown",
  };
}

async function readLogs(
  serviceManager: UserServiceManager,
  control: HostLifecycleControl,
  options: HostLogReadOptions | undefined,
): Promise<HostLogReadResult> {
  const response = await control.request({
    type: "logs",
    principal: "local",
    ...(options?.since === undefined ? {} : { since: options.since }),
    ...(options?.limit === undefined ? {} : { limit: options.limit }),
    ...(options?.follow === undefined ? {} : { follow: options.follow }),
  });
  return response?.logs ?? (await serviceManager.logs(options));
}

interface ReadinessObservation {
  readonly response?: HostRuntimeControlResponse;
  readonly diagnostics?: HostRuntimeDiagnostics;
}

async function waitForReady(
  control: HostLifecycleControl,
  sleep = (milliseconds: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
): Promise<ReadinessObservation> {
  let lastResponse: HostRuntimeControlResponse | undefined;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await control.request({ type: "status", principal: "local" });
    lastResponse = response;
    if (response?.error === "unauthorized" || response?.error === "incompatible") {
      return { response };
    }
    if (response?.ok === true && response.owner !== undefined) {
      const diagnosticsResponse = await control.request({
        type: "diagnostics",
        principal: "local",
      });
      if (diagnosticsResponse?.diagnostics !== undefined) {
        if (diagnosticsReadyForOwner(diagnosticsResponse.diagnostics, response.owner)) {
          return {
            response: { ...response, diagnostics: diagnosticsResponse.diagnostics },
            diagnostics: diagnosticsResponse.diagnostics,
          };
        }
        return { response, diagnostics: diagnosticsResponse.diagnostics };
      }
    }
    await sleep(100);
  }
  return lastResponse === undefined ? {} : { response: lastResponse };
}

type StopAcceptance = "acknowledged" | "no-owner" | "rejected";

async function requestStop(
  control: HostLifecycleControl,
  serviceManager: UserServiceManager,
  sleep = (milliseconds: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
): Promise<StopAcceptance> {
  const response = await control.request({ type: "stop", principal: "local" });
  if (response?.ok === true) return "acknowledged";
  if (response?.error === "unauthorized") return "rejected";

  // A missing/failed stop response is not success. The only idempotent
  // exception is a manager-confirmed inactive service followed by a second
  // owner-status request that proves there is no owner to stop.
  const manager = await serviceManager.status();
  if (manager.active) return "rejected";
  const status = await control.request({ type: "status", principal: "local" });
  if (status?.ok === true && status.owner === undefined) return "no-owner";
  if (control.proveNoOwner === undefined) return "rejected";
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await control.proveNoOwner()) return "no-owner";
    if (attempt < 49) await sleep(100);
  }
  return "rejected";
}

async function proveNoOwner(paths: HostRuntimePaths): Promise<boolean> {
  const artifacts = [paths.socketPath, paths.ownerReceiptPath, paths.controlSecretPath];
  const present = await Promise.all(
    artifacts.map(async (path) => {
      try {
        await lstat(path);
        return true;
      } catch (error) {
        return !isMissing(error);
      }
    }),
  );
  return present.every((value) => value === false);
}

function ownerObservation(
  response: HostRuntimeControlResponse | undefined,
  diagnostics: HostRuntimeDiagnostics | undefined,
  managerActive: boolean,
  requireReadyDiagnostics: boolean,
) {
  if (response?.error === "unauthorized") return "unauthorized" as const;
  if (response?.error === "incompatible" || response?.error === "owner-incompatible") {
    return "incompatible" as const;
  }
  if (
    diagnostics !== undefined &&
    (diagnostics.store.state !== "current" || diagnostics.store.integrity !== "ok")
  ) {
    return requireReadyDiagnostics &&
      (diagnostics.store.state === "unknown" || diagnostics.store.integrity === "unknown")
      ? ("starting" as const)
      : ("degraded" as const);
  }
  if (requireReadyDiagnostics && response?.owner !== undefined && diagnostics === undefined) {
    return "starting" as const;
  }
  if (response?.owner !== undefined) return "ready" as const;
  return managerActive ? ("starting" as const) : ("none" as const);
}

function diagnosticsReadyForOwner(diagnostics: HostRuntimeDiagnostics, owner: unknown): boolean {
  if (diagnostics.store.state !== "current" || diagnostics.store.integrity !== "ok") return false;
  if (typeof owner !== "object" || owner === null || Array.isArray(owner)) return true;
  const instanceId = (owner as Record<string, unknown>).instanceId;
  return typeof instanceId !== "string" || diagnostics.identity.instanceId === instanceId;
}

async function followServerLogs(input: {
  readonly dependencies: ServerLifecycleDependencies;
  readonly policy: HostServicePolicy;
  readonly serviceManager: UserServiceManager;
  readonly control: HostLifecycleControl;
}): Promise<ServerLifecycleReport> {
  const { dependencies, policy, serviceManager, control } = input;
  const sleep =
    dependencies.sleep ??
    ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  let since = dependencies.logs?.since;
  let lastReport: ServerLifecycleReport | undefined;
  while (dependencies.signal?.aborted !== true) {
    const options = {
      ...dependencies.logs,
      follow: true as const,
      ...(since === undefined ? {} : { since }),
    };
    const logs = await readLogs(serviceManager, control, options);
    lastReport = await buildReport({ policy, serviceManager, control, logs });
    if (logs.entries.length > 0) writeReport(lastReport, dependencies.stdout);
    if (logs.nextSince !== undefined) since = logs.nextSince;
    if (dependencies.signal?.aborted) break;
    await sleep(250);
  }
  if (lastReport !== undefined) return lastReport;
  const logs = await readLogs(serviceManager, control, {
    ...dependencies.logs,
    follow: true,
  });
  const report = await buildReport({ policy, serviceManager, control, logs });
  return writeReport(report, dependencies.stdout);
}

function diagnosticsFromOwner(owner: unknown): HostRuntimeDiagnostics | undefined {
  if (typeof owner !== "object" || owner === null || Array.isArray(owner)) return undefined;
  const value = owner as Record<string, unknown>;
  if (
    typeof value.hostId !== "string" ||
    typeof value.instanceId !== "string" ||
    typeof value.endpoint !== "string" ||
    typeof value.serviceMode !== "string" ||
    typeof value.serverVersion !== "string" ||
    typeof value.wireVersion !== "string"
  ) {
    return undefined;
  }
  return {
    identity: {
      hostId: value.hostId,
      instanceId: value.instanceId,
      endpoint: value.endpoint,
      serviceMode: value.serviceMode,
    },
    version: { server: value.serverVersion, wire: value.wireVersion },
    store: { state: "unknown", integrity: "unknown" },
    replay: { journalHead: 0, projections: 0 },
    clients: { connected: 0 },
    capabilities: [],
    work: { active: 0, attentionRequired: false },
    uptimeSeconds: 0,
  };
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}

function defaultPolicyStore(paths: HostRuntimePaths | undefined): ServicePolicyStore {
  if (paths === undefined)
    throw new ServiceManagerError("manager-failed", "Host runtime paths are required.");
  return new ServicePolicyStore({ path: paths.servicePolicyPath });
}

function defaultServiceManager(paths: HostRuntimePaths | undefined): UserServiceManager {
  if (paths === undefined)
    throw new ServiceManagerError("manager-failed", "Host runtime paths are required.");
  return createUserServiceManager({ paths, uid: paths.uid, runtimeEnvironment: process.env });
}

function defaultControl(paths: HostRuntimePaths | undefined): HostLifecycleControl {
  if (paths === undefined)
    throw new ServiceManagerError("manager-failed", "Host runtime paths are required.");
  return createLocalHostLifecycleControl(paths);
}

function writeReport(
  report: ServerLifecycleReport,
  stdout: { write: (chunk: string) => unknown } | undefined,
): ServerLifecycleReport {
  stdout?.write(formatServerLifecycleReport(report));
  return report;
}

export function formatServerLifecycleReport(report: ServerLifecycleReport): string {
  if (report.logs !== undefined) {
    return `${report.logs.entries.map((entry) => `${entry.timestamp} ${entry.level} ${entry.event}: ${entry.message}`).join("\n")}\n`;
  }
  const lines = [
    `Octant server service: ${report.state}`,
    `Policy: ${report.policy.enabled ? "enabled" : "disabled"}`,
    `Manager: ${report.manager.kind} (${report.manager.active ? "active" : "inactive"})`,
    report.message,
  ];
  if (report.diagnostics !== undefined) {
    lines.push(`Host: ${report.diagnostics.identity.hostId}`);
    lines.push(`Instance: ${report.diagnostics.identity.instanceId}`);
    lines.push(`Version: ${report.diagnostics.version.server}`);
    lines.push(
      `Store: ${report.diagnostics.store.state} (integrity ${report.diagnostics.store.integrity})`,
    );
    lines.push(
      `Replay: journal=${report.diagnostics.replay.journalHead} projections=${report.diagnostics.replay.projections}`,
    );
    lines.push(`Clients: ${report.diagnostics.clients.connected}`);
    lines.push(`Capabilities: ${report.diagnostics.capabilities.join(", ") || "none"}`);
    lines.push(
      `Active work: ${report.diagnostics.work.active} (attention=${report.diagnostics.work.attentionRequired})`,
    );
    lines.push(`Service mode: ${report.diagnostics.identity.serviceMode}`);
    lines.push(`Endpoint: ${report.diagnostics.identity.endpoint}`);
    lines.push(`Wire version: ${report.diagnostics.version.wire}`);
    lines.push(
      `Uptime: ${report.diagnostics.uptimeSeconds === undefined ? "unknown" : `${report.diagnostics.uptimeSeconds}s`}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function messageFor(state: HostServiceStateName): string {
  return {
    disabled: "Automatic startup is disabled; foreground `server run` remains available.",
    stopped: "The per-user service is stopped.",
    starting: "The per-user service is starting.",
    ready: "The authenticated owner is ready.",
    degraded: "The owner is running but requires attention.",
    "crash-loop": "The service is restarting repeatedly and requires attention.",
    incompatible: "The owner is incompatible with this CLI.",
    unauthorized: "The local owner authority is unavailable or unauthorized.",
    "manager-unavailable":
      "The per-user service manager is unavailable; foreground run remains available.",
  }[state];
}
