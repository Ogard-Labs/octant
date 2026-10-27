import { createHash, timingSafeEqual } from "node:crypto";
import { Schema } from "effect";
import {
  SshHostKeyProbeRequest,
  SshRuntimeBinarySetRequest,
  SshTargetRegisterRequest,
  SshTargetRepinRequest,
  SshTargetRequest,
  type SshTargetId,
  type SshTargetList,
} from "@octant/contracts/ssh-target";
import {
  SshRemoteDirectoryRequest,
  SshRemoteFileRequest,
  SshRemoteGitDiffRequest,
  SshRemoteGitStatusRequest,
  SshRemoteProjectBindRequest,
  SshRemoteTerminalCommand,
  SshRemoteWorktreeCreateRequest,
  SshRemoteWorktreeRequest,
  type SshRemoteProjectList,
  type SshRemoteWorktreeList,
} from "@octant/contracts/ssh-remote-project";
import { isLoopbackHostname } from "../shellRoutes";
import type { WindowId } from "@octant/contracts/shell";
import { WindowAuthorityError, type WindowAuthorityStore } from "../windowAuthorityStore";
import type { SshRemoteProjectResult, SshRemoteProjectService } from "./sshRemoteProjectService";
import type { SshRemoteTerminalService } from "./sshRemoteTerminalService";
import type {
  SshTargetAdministrationResult,
  SshTargetConnectionService,
} from "./sshTargetConnectionService";

/**
 * Local administration of SSH targets. Canonical:
 * docs/design/remote-ssh-environments.md § Registering an SSH target.
 *
 * Registering a target, accepting its host key, and removing it are a
 * person's acts at this machine, as listener administration is: these routes
 * answer only on the loopback interface, to a caller holding the desktop
 * bridge secret and a window capability, with no Origin header. A paired
 * device never reaches them, because the remote gateway keeps every
 * `/api/desktop` path local and holds no bridge secret to present.
 *
 * Where a provider's runtime is on a target is set here too, so the path a
 * placed runtime launches is the person's, never a paired device's, the
 * model's, or the target's own report.
 *
 * Binding a remote root is local in the same way. The reads of a bound root,
 * its managed worktrees, and a person's terminals on it sit here too until
 * remote-bound Projects join the product routes with their threads: until
 * then no paired device can reach a target's files or shells at all. A
 * terminal belongs to the window whose capability opened it.
 */

const DEFAULT_BODY_LIMIT = 16 * 1_024;

export const SSH_TARGET_ROUTES = {
  list: "/api/desktop/ssh-targets",
  hostKey: "/api/desktop/ssh-targets/host-key",
  register: "/api/desktop/ssh-targets/register",
  repin: "/api/desktop/ssh-targets/repin",
  connect: "/api/desktop/ssh-targets/connect",
  remove: "/api/desktop/ssh-targets/remove",
  runtimeBinary: "/api/desktop/ssh-targets/runtime-binary",
  projects: "/api/desktop/ssh-targets/projects",
  bind: "/api/desktop/ssh-targets/projects/bind",
  files: "/api/desktop/ssh-targets/projects/files",
  file: "/api/desktop/ssh-targets/projects/file",
  gitStatus: "/api/desktop/ssh-targets/projects/git-status",
  gitDiff: "/api/desktop/ssh-targets/projects/git-diff",
  worktrees: "/api/desktop/ssh-targets/projects/worktrees",
  worktreeCreate: "/api/desktop/ssh-targets/projects/worktrees/create",
  worktreeRemove: "/api/desktop/ssh-targets/projects/worktrees/remove",
  terminal: "/api/desktop/ssh-targets/projects/terminal",
} as const;

/** A terminal's input can be a whole paste, so its route takes a larger body. */
const TERMINAL_BODY_LIMIT = 192 * 1_024;

type RouteValue = (typeof SSH_TARGET_ROUTES)[keyof typeof SSH_TARGET_ROUTES];
const ROUTE_VALUES: ReadonlySet<string> = new Set(Object.values(SSH_TARGET_ROUTES));

export interface SshTargetAdministrationRouteOptions {
  readonly desktopBridgeSecret: string | undefined;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly connections: SshTargetConnectionService;
  readonly projects: SshRemoteProjectService;
  readonly terminals: SshRemoteTerminalService;
  /**
   * Whether a thread on one of the target's Projects holds a turn now.
   * Removal ends the target's session, which would end that turn under it.
   */
  readonly threadRunsOnTarget: (targetId: SshTargetId) => boolean;
  readonly maxRequestBodySize?: number;
  readonly now?: () => number;
}

export function createSshTargetAdministrationRouteHandler(
  options: SshTargetAdministrationRouteOptions,
): (request: Request) => Promise<Response | undefined> {
  const maxBody = options.maxRequestBodySize ?? DEFAULT_BODY_LIMIT;
  const now = options.now ?? Date.now;
  return async (request) => {
    const url = new URL(request.url);
    if (!ROUTE_VALUES.has(url.pathname)) return undefined;
    const route = url.pathname as RouteValue;
    if (options.desktopBridgeSecret === undefined) return failure("unavailable", 503);
    if (
      !isLoopbackHostname(url.hostname) ||
      request.headers.has("origin") ||
      !secretsEqual(
        options.desktopBridgeSecret,
        request.headers.get("x-octant-desktop-secret") ?? "",
      )
    ) {
      return failure("unauthorized", 401);
    }
    let windowId: WindowId;
    try {
      windowId = options.windowAuthorityStore.authenticate(
        request.headers.get("x-octant-window-capability") ?? "",
        now(),
      );
    } catch (error) {
      return failure(error instanceof WindowAuthorityError ? "unauthorized" : "invalid", 401);
    }
    if (url.search !== "") return failure("invalid", 400);

    const { connections, projects } = options;
    if (route === SSH_TARGET_ROUTES.list) {
      if (request.method !== "GET") return failure("invalid", 405);
      const list: SshTargetList = { targets: connections.list() };
      return Response.json(list);
    }
    if (route === SSH_TARGET_ROUTES.projects) {
      if (request.method !== "GET") return failure("invalid", 405);
      const list: SshRemoteProjectList = { projects: projects.list() };
      return Response.json(list);
    }
    if (route === SSH_TARGET_ROUTES.worktrees) {
      if (request.method !== "GET") return failure("invalid", 405);
      const list: SshRemoteWorktreeList = { worktrees: projects.listWorktrees() };
      return Response.json(list);
    }
    if (request.method !== "POST") return failure("invalid", 405);
    if (request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json") {
      return failure("invalid", 415);
    }
    const body = await readJson(
      request,
      route === SSH_TARGET_ROUTES.terminal ? Math.max(maxBody, TERMINAL_BODY_LIMIT) : maxBody,
    );
    if (body.kind !== "ok") return failure("invalid", body.kind === "too-large" ? 413 : 400);

    switch (route) {
      case SSH_TARGET_ROUTES.hostKey: {
        const decoded = Schema.decodeUnknownEither(SshHostKeyProbeRequest)(body.value);
        if (decoded._tag === "Left") return failure("invalid", 400);
        return answer(await connections.probeHostKey(decoded.right.destination));
      }
      case SSH_TARGET_ROUTES.register: {
        const decoded = Schema.decodeUnknownEither(SshTargetRegisterRequest)(body.value);
        if (decoded._tag === "Left") return failure("invalid", 400);
        return answer(await connections.register(decoded.right));
      }
      case SSH_TARGET_ROUTES.repin: {
        const decoded = Schema.decodeUnknownEither(SshTargetRepinRequest)(body.value);
        if (decoded._tag === "Left") return failure("invalid", 400);
        return answer(await connections.repin(decoded.right));
      }
      case SSH_TARGET_ROUTES.connect: {
        const decoded = Schema.decodeUnknownEither(SshTargetRequest)(body.value);
        if (decoded._tag === "Left") return failure("invalid", 400);
        return answer(await connections.connect(decoded.right.targetId));
      }
      case SSH_TARGET_ROUTES.runtimeBinary: {
        const decoded = Schema.decodeUnknownEither(SshRuntimeBinarySetRequest)(body.value);
        if (decoded._tag === "Left") return failure("invalid", 400);
        return answer(connections.setRuntimeBinary(decoded.right));
      }
      case SSH_TARGET_ROUTES.bind: {
        const decoded = Schema.decodeUnknownEither(SshRemoteProjectBindRequest)(body.value);
        if (decoded._tag === "Left") return failure("invalid", 400);
        return answerProject(await projects.bind(decoded.right));
      }
      case SSH_TARGET_ROUTES.files: {
        const decoded = Schema.decodeUnknownEither(SshRemoteDirectoryRequest)(body.value);
        if (decoded._tag === "Left") return failure("invalid", 400);
        return answerProject(await projects.listDirectory(decoded.right));
      }
      case SSH_TARGET_ROUTES.file: {
        const decoded = Schema.decodeUnknownEither(SshRemoteFileRequest)(body.value);
        if (decoded._tag === "Left") return failure("invalid", 400);
        return answerProject(await projects.readFile(decoded.right));
      }
      case SSH_TARGET_ROUTES.gitStatus: {
        const decoded = Schema.decodeUnknownEither(SshRemoteGitStatusRequest)(body.value);
        if (decoded._tag === "Left") return failure("invalid", 400);
        return answerProject(await projects.gitStatus(decoded.right));
      }
      case SSH_TARGET_ROUTES.gitDiff: {
        const decoded = Schema.decodeUnknownEither(SshRemoteGitDiffRequest)(body.value);
        if (decoded._tag === "Left") return failure("invalid", 400);
        return answerProject(await projects.gitDiff(decoded.right));
      }
      case SSH_TARGET_ROUTES.worktreeCreate: {
        const decoded = Schema.decodeUnknownEither(SshRemoteWorktreeCreateRequest)(body.value);
        if (decoded._tag === "Left") return failure("invalid", 400);
        return answerProject(await projects.createWorktree(decoded.right));
      }
      case SSH_TARGET_ROUTES.worktreeRemove: {
        const decoded = Schema.decodeUnknownEither(SshRemoteWorktreeRequest)(body.value);
        if (decoded._tag === "Left") return failure("invalid", 400);
        const removed = await projects.removeWorktree(decoded.right);
        return removed.status === "ok"
          ? new Response(null, { status: 204 })
          : answerProject(removed);
      }
      case SSH_TARGET_ROUTES.terminal: {
        const decoded = Schema.decodeUnknownEither(SshRemoteTerminalCommand)(body.value);
        if (decoded._tag === "Left") return failure("invalid", 400);
        // A refusal is part of the answer, as a local Project terminal's is:
        // the window shows the host's sentence.
        return Response.json(await options.terminals.execute(windowId, decoded.right));
      }
      case SSH_TARGET_ROUTES.remove: {
        const decoded = Schema.decodeUnknownEither(SshTargetRequest)(body.value);
        if (decoded._tag === "Left") return failure("invalid", 400);
        // Checked and removed in one step, so no turn starts between them;
        // one that starts after finds the target gone.
        if (options.threadRunsOnTarget(decoded.right.targetId)) {
          return Response.json(
            {
              status: "refused",
              reason: "target-in-use",
              message:
                "A thread on this target is running. Stop it, or wait for it to end, then remove the target.",
            },
            { status: 409 },
          );
        }
        const removed = connections.remove(decoded.right.targetId);
        return removed.status === "ok"
          ? new Response(null, { status: 204 })
          : Response.json(removed, { status: 409 });
      }
    }
    return failure("invalid", 400);
  };
}

function answer<T>(result: SshTargetAdministrationResult<T>): Response {
  return result.status === "ok"
    ? Response.json(result.value)
    : Response.json(result, { status: result.reason === "unknown-target" ? 404 : 409 });
}

function answerProject<T>(result: SshRemoteProjectResult<T>): Response {
  return result.status === "ok"
    ? Response.json(result.value)
    : Response.json(result, {
        status:
          result.reason === "unknown-project" || result.reason === "unknown-worktree" ? 404 : 409,
      });
}

async function readJson(
  request: Request,
  maxBody: number,
): Promise<
  { readonly kind: "ok"; readonly value: unknown } | { readonly kind: "invalid" | "too-large" }
> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBody) return { kind: "too-large" };
  let text: string;
  try {
    text = await request.text();
  } catch {
    return { kind: "invalid" };
  }
  if (Buffer.byteLength(text, "utf8") > maxBody) return { kind: "too-large" };
  try {
    return { kind: "ok", value: JSON.parse(text) };
  } catch {
    return { kind: "invalid" };
  }
}

function secretsEqual(expected: string, actual: string): boolean {
  const left = createHash("sha256").update(expected, "utf8").digest();
  const right = createHash("sha256").update(actual, "utf8").digest();
  return timingSafeEqual(left, right);
}

function failure(category: "invalid" | "unauthorized" | "unavailable", status: number): Response {
  return Response.json(
    {
      category,
      message:
        category === "unavailable"
          ? "SSH target administration is unavailable."
          : category === "unauthorized"
            ? "SSH target administration is unauthorized."
            : "SSH target administration request is invalid.",
    },
    { status },
  );
}
