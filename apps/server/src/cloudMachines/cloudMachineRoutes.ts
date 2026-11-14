import {
  decodeCloudMachinesCommand,
  type CloudMachinesCommand,
  type CloudMachinesCommandResult,
  type CloudMachinesRefusalReason,
} from "@octant/contracts/cloud-machines";
import { authenticateRoutePrincipal, boundPrincipalIsRestricted } from "../principalRouteContext";
import { isLoopbackHostname } from "../shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "../windowAuthorityStore";
import type {
  CloudMachinePrincipal,
  CloudMachinesChange,
  CloudMachineService,
} from "./cloudMachineService";

const ROUTE = "/api/cloud-machines";
const METHODS = "GET, POST, OPTIONS";
const HEADERS = "content-type, x-octant-window-capability";

export interface CloudMachineRouteDependencies {
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly service: Pick<
    CloudMachineService,
    | "view"
    | "create"
    | "bindProject"
    | "refresh"
    | "suspend"
    | "resume"
    | "requestDestroy"
    | "destroy"
  >;
  readonly now?: () => number;
}

function corsHeaders(origin: string | null): Record<string, string> {
  return {
    "access-control-allow-origin": origin ?? "",
    "access-control-allow-methods": METHODS,
    "access-control-allow-headers": HEADERS,
  };
}

function json(data: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders(origin) },
  });
}

/**
 * Machines in the person's cloud account. The principal comes from the
 * authenticated request, never from the body; only a local window acts, and
 * the service refuses every other principal before it asks a target anything.
 */
export function createCloudMachineRouteHandler(dependencies: CloudMachineRouteDependencies) {
  const now = dependencies.now ?? Date.now;
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (url.pathname !== ROUTE) return undefined;
    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname)) {
      return json({ error: "Cloud machine requests must use loopback." }, 400, null);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== "GET" && request.method !== "POST") {
      return json({ error: "Method not allowed." }, 405, origin);
    }
    let body: unknown;
    if (request.method === "POST") {
      try {
        body = await request.json();
      } catch {
        return json({ error: "Cloud machine body must be valid JSON." }, 400, origin);
      }
    }
    let principal: CloudMachinePrincipal;
    try {
      const context = authenticateRoutePrincipal({
        request,
        store: dependencies.windowAuthorityStore,
        now: now(),
        ...(body === undefined ? {} : { body }),
      });
      principal = context.principal.kind === "local-window" ? "local-window" : "remote-device";
    } catch (error) {
      if (error instanceof WindowAuthorityError) {
        return json({ error: "Cloud machine request is unauthorized." }, 401, origin);
      }
      return json({ error: "Cloud machine request is invalid." }, 400, origin);
    }
    if (boundPrincipalIsRestricted(request)) {
      return json({ error: "Cloud machines are reached only at this computer." }, 403, origin);
    }
    if (request.method === "GET") {
      return json({ view: dependencies.service.view() }, 200, origin);
    }
    let command: CloudMachinesCommand;
    try {
      command = decodeCloudMachinesCommand(body);
    } catch {
      return json({ error: "Cloud machine command is invalid." }, 400, origin);
    }
    const change = await run(dependencies.service, command, principal);
    const result: CloudMachinesCommandResult =
      change.kind === "refused"
        ? {
            kind: "cloud-machines-refused",
            reason: change.reason,
            message: change.message ?? MESSAGES[change.reason],
          }
        : change.kind === "confirm"
          ? {
              kind: "cloud-machine-destroy-confirmation",
              machineId: change.machineId,
              name: change.name,
              confirmation: change.confirmation,
              expiresAt: change.expiresAt,
            }
          : { kind: "cloud-machines-updated", view: dependencies.service.view() };
    return json(result, result.kind === "cloud-machines-refused" ? 409 : 200, origin);
  };
}

function run(
  service: CloudMachineRouteDependencies["service"],
  command: CloudMachinesCommand,
  principal: CloudMachinePrincipal,
): Promise<CloudMachinesChange> | CloudMachinesChange {
  switch (command.kind) {
    case "create-cloud-machine":
      return service.create({
        targetId: command.targetId,
        name: command.name,
        recipe: command.recipe,
        credentialReference: command.credentialReference,
        folder: command.folder,
        mode: command.mode,
        principal,
      });
    case "bind-cloud-machine-project":
      return service.bindProject({ machineId: String(command.machineId), principal });
    case "refresh-cloud-machine":
      return service.refresh({ machineId: String(command.machineId), principal });
    case "suspend-cloud-machine":
      return service.suspend({ machineId: String(command.machineId), principal });
    case "resume-cloud-machine":
      return service.resume({ machineId: String(command.machineId), principal });
    case "request-cloud-machine-destroy":
      return service.requestDestroy({ machineId: String(command.machineId), principal });
    case "destroy-cloud-machine":
      return service.destroy({
        machineId: String(command.machineId),
        confirmation: command.confirmation,
        principal,
      });
  }
}

const MESSAGES: Readonly<Record<CloudMachinesRefusalReason, string>> = {
  "needs-person": "Only a person can create, suspend, resume or destroy a cloud machine.",
  "needs-local-window": "Cloud machines can be changed only at this computer.",
  "target-not-offered": "That cloud machine plugin is not installed, trusted and enabled.",
  "credential-unavailable":
    "The cloud account's credential is not available from the credential broker.",
  "too-many-machines": "No more cloud machines can be created.",
  "machine-not-found": "That cloud machine does not exist or was not created.",
  "machine-busy": "Another change to this machine is still in progress.",
  "machine-not-running": "Only a running machine can be suspended.",
  "machine-not-suspended": "Only a suspended machine can be resumed.",
  "confirmation-required": "Destroying a machine needs your confirmation for that machine.",
  "provider-refused": "The cloud provider declined, and nothing changed.",
  "provider-failed": "The cloud provider did not answer. Check the machine in your cloud account.",
  "binding-refused": "The machine's server Project could not be bound.",
  unavailable: "The change could not be recorded.",
};
