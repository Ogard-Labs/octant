import { randomUUID } from "node:crypto";
import { basename, resolve } from "node:path";
import { decodeProjectBootstrap, LOCAL_HOST_ID, type ProjectSummary } from "@octant/contracts";
import { failureMessage, type OpenedLocalControlSession } from "./localControl";

export type ProjectCliCommand =
  | {
      readonly action: "add";
      readonly path: string;
      readonly projectType: "work" | "code";
      readonly name?: string;
    }
  | { readonly action: "remove"; readonly name: string }
  | { readonly action: "rename"; readonly name: string; readonly newName: string };

const ALLOWED_FLAGS: Readonly<Record<ProjectCliCommand["action"], readonly string[]>> = {
  add: ["name", "type"],
  remove: [],
  rename: [],
};

export function resolveProjectCliCommand(
  positional: readonly string[],
  flags: Readonly<Record<string, string | boolean>>,
): ProjectCliCommand | undefined {
  const [action, ...rest] = positional;
  if (action !== "add" && action !== "remove" && action !== "rename") return undefined;
  const allowed = ALLOWED_FLAGS[action];
  if (Object.keys(flags).some((flag) => !allowed.includes(flag))) return undefined;
  if (action === "add") {
    const [path] = rest;
    if (path === undefined || rest.length !== 1) return undefined;
    const type = flags.type ?? "code";
    if (type !== "work" && type !== "code") return undefined;
    const name = flags.name;
    if (name !== undefined && (typeof name !== "string" || name.trim() === "")) return undefined;
    return {
      action: "add",
      path,
      projectType: type,
      ...(typeof name === "string" ? { name: name.trim() } : {}),
    };
  }
  if (action === "remove") {
    const [name] = rest;
    if (name === undefined || rest.length !== 1 || name.trim() === "") return undefined;
    return { action: "remove", name: name.trim() };
  }
  const [name, newName] = rest;
  if (name === undefined || newName === undefined || rest.length !== 2) return undefined;
  if (name.trim() === "" || newName.trim() === "") return undefined;
  return { action: "rename", name: name.trim(), newName: newName.trim() };
}

export interface RunProjectCliCommandInput {
  readonly command: ProjectCliCommand;
  readonly session: OpenedLocalControlSession;
  readonly cwd: string;
  readonly stdout: { readonly write: (chunk: string) => unknown };
  readonly stderr: { readonly write: (chunk: string) => unknown };
}

export async function runProjectCliCommand(input: RunProjectCliCommandInput): Promise<number> {
  const { command, session } = input;
  if (command.action === "add") {
    const path = resolve(input.cwd, command.path);
    const receipt = await session.send({
      path: "/api/desktop/project-binding-receipts",
      method: "POST",
      body: { windowId: session.windowId, projectType: command.projectType, path },
    });
    if (receipt.status !== 201) {
      input.stderr.write(`${failureMessage(receipt, "Octant refused this Project root.")}\n`);
      return 1;
    }
    const receiptId = receiptIdOf(receipt.body);
    if (receiptId === undefined) {
      input.stderr.write("Octant returned an unusable Project binding receipt.\n");
      return 1;
    }
    const name = command.name ?? basename(path);
    const executed = await session.send({
      path: "/api/projects/commands",
      method: "POST",
      body: {
        kind: command.projectType === "work" ? "create-work-project" : "create-code-project",
        projectId: randomUUID(),
        expectedVersion: 0,
        name,
        receiptId,
        hostId: LOCAL_HOST_ID,
      },
    });
    if (executed.status !== 200) {
      input.stderr.write(`${failureMessage(executed, "Octant refused this Project.")}\n`);
      return 1;
    }
    input.stdout.write(`${command.projectType === "work" ? "Work" : "Code"} Project ${name}\n`);
    input.stdout.write(`${path}\n`);
    return 0;
  }

  const projects = await readProjects(session);
  if (projects.kind === "refuses") {
    input.stderr.write(`${projects.reason}\n`);
    return 1;
  }
  const matches = projects.active.filter((project) => project.name === command.name);
  if (matches.length === 0) {
    input.stderr.write(`No active Project is named ${command.name}.\n`);
    return 1;
  }
  const [project] = matches;
  if (matches.length > 1 || project === undefined) {
    input.stderr.write(
      `More than one active Project is named ${command.name}. Rename them in Octant first.\n`,
    );
    return 1;
  }
  const executed = await session.send({
    path: "/api/projects/commands",
    method: "POST",
    body:
      command.action === "remove"
        ? {
            kind: "change-project-lifecycle",
            projectId: project.id,
            expectedVersion: project.version,
            lifecycle: "archived",
          }
        : {
            kind: "rename-project",
            projectId: project.id,
            expectedVersion: project.version,
            name: command.newName,
          },
  });
  if (executed.status !== 200) {
    input.stderr.write(`${failureMessage(executed, "Octant refused this Project change.")}\n`);
    return 1;
  }
  input.stdout.write(
    command.action === "remove"
      ? `Archived Project ${project.name}. Its threads and memory are kept.\n`
      : `Renamed Project ${project.name} to ${command.newName}.\n`,
  );
  return 0;
}

async function readProjects(
  session: OpenedLocalControlSession,
): Promise<
  | { readonly kind: "read"; readonly active: ReadonlyArray<ProjectSummary> }
  | { readonly kind: "refuses"; readonly reason: string }
> {
  const response = await session.send({ path: "/api/projects/bootstrap", method: "GET" });
  if (response.status !== 200) {
    return {
      kind: "refuses",
      reason: failureMessage(response, "Octant refused to list Projects."),
    };
  }
  try {
    return { kind: "read", active: decodeProjectBootstrap(response.body).active };
  } catch {
    return { kind: "refuses", reason: "Octant returned an unreadable Project list." };
  }
}

function receiptIdOf(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  const receiptId = (body as Record<string, unknown>).receiptId;
  return typeof receiptId === "string" && receiptId !== "" ? receiptId : undefined;
}
