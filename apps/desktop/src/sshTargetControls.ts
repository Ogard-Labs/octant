/**
 * The desktop's side of Settings › SSH targets: each operation a window may
 * ask for is one of the host's local SSH target routes, sent with the desktop
 * bridge secret and that window's own capability. Canonical:
 * docs/design/remote-ssh-environments.md § Registering an SSH target.
 *
 * Main forwards only the operations named here, to their fixed paths, and
 * hands the host's answer back as it was given; the host decodes every body
 * against its schemas and decides. A paired device never reaches these routes,
 * because only this process holds the bridge secret.
 */

export const SSH_TARGET_OPERATIONS = {
  list: { method: "GET", path: "/api/desktop/ssh-targets" },
  "probe-host-key": { method: "POST", path: "/api/desktop/ssh-targets/host-key" },
  register: { method: "POST", path: "/api/desktop/ssh-targets/register" },
  repin: { method: "POST", path: "/api/desktop/ssh-targets/repin" },
  connect: { method: "POST", path: "/api/desktop/ssh-targets/connect" },
  remove: { method: "POST", path: "/api/desktop/ssh-targets/remove" },
  projects: { method: "GET", path: "/api/desktop/ssh-targets/projects" },
  bind: { method: "POST", path: "/api/desktop/ssh-targets/projects/bind" },
  worktrees: { method: "GET", path: "/api/desktop/ssh-targets/projects/worktrees" },
  "create-worktree": {
    method: "POST",
    path: "/api/desktop/ssh-targets/projects/worktrees/create",
  },
  "remove-worktree": {
    method: "POST",
    path: "/api/desktop/ssh-targets/projects/worktrees/remove",
  },
  terminal: { method: "POST", path: "/api/desktop/ssh-targets/projects/terminal" },
} as const satisfies Readonly<
  Record<string, { readonly method: "GET" | "POST"; readonly path: string }>
>;

export type SshTargetOperation = keyof typeof SSH_TARGET_OPERATIONS;

export interface SshTargetAnswer {
  readonly status: number;
  readonly body: unknown;
}

/** The largest body a window may send; a terminal's paste is the largest. */
const MAX_BODY_BYTES = 192 * 1_024;

export function isSshTargetOperation(value: unknown): value is SshTargetOperation {
  return typeof value === "string" && Object.hasOwn(SSH_TARGET_OPERATIONS, value);
}

export class SshTargetControlFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SshTargetControlFailure";
  }
}

export interface SshTargetControlRuntime {
  readonly serverUrl: string;
  readonly desktopBridgeSecret: string;
  readonly windowCapability: string;
  readonly fetch: typeof globalThis.fetch;
}

/**
 * Sends one operation to the host. A refusal is an answer, returned with its
 * status; only a request that never reached the host, or an operation or body
 * that is not one a window may send, throws.
 */
export async function sendSshTargetOperation(
  runtime: SshTargetControlRuntime,
  operation: unknown,
  body: unknown,
): Promise<SshTargetAnswer> {
  if (!isSshTargetOperation(operation)) {
    throw new SshTargetControlFailure("Octant refused an unknown SSH target request.");
  }
  const { method, path } = SSH_TARGET_OPERATIONS[operation];
  let encoded: string | undefined;
  if (method === "POST") {
    encoded = JSON.stringify(body ?? {});
    if (Buffer.byteLength(encoded, "utf8") > MAX_BODY_BYTES) {
      throw new SshTargetControlFailure("Octant refused an SSH target request that is too large.");
    }
  }
  let response: Response;
  try {
    response = await runtime.fetch(new URL(path, runtime.serverUrl), {
      method,
      headers: {
        "x-octant-desktop-secret": runtime.desktopBridgeSecret,
        "x-octant-window-capability": runtime.windowCapability,
        ...(encoded === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(encoded === undefined ? {} : { body: encoded }),
    });
  } catch {
    throw new SshTargetControlFailure("Octant SSH target controls are unavailable.");
  }
  if (response.status === 204) return { status: 204, body: null };
  const text = await response.text().catch(() => "");
  let value: unknown = null;
  try {
    value = text === "" ? null : JSON.parse(text);
  } catch {
    value = null;
  }
  return { status: response.status, body: value };
}
