import { decodeProjectBootstrap, type ProjectBootstrap } from "@octant/contracts/projects";
import type { RemoteSessionBridge } from "./remoteSessionBridge";
import { canExecuteRemoteProductMutation } from "./remoteShellHealth";

export class RemoteProjectOverviewFailure extends Error {
  readonly category: "offline" | "rejected" | "unavailable";

  constructor(category: "offline" | "rejected" | "unavailable", message: string) {
    super(message);
    this.name = "RemoteProjectOverviewFailure";
    this.category = category;
  }
}

export interface RemoteProjectSnapshotRegistry {
  readonly read: () => ProjectBootstrap | undefined;
  readonly write: (snapshot: ProjectBootstrap) => void;
  readonly clear: () => void;
}

export function createRemoteProjectSnapshotRegistry(): RemoteProjectSnapshotRegistry {
  let snapshot: ProjectBootstrap | undefined;
  return {
    read: () => snapshot,
    write: (value) => {
      snapshot = value;
    },
    clear: () => {
      snapshot = undefined;
    },
  };
}

/** Fetch authoritative Project bootstrap over the authenticated remote session. */
export async function fetchRemoteProjectBootstrap(input: {
  readonly bridge: RemoteSessionBridge;
}): Promise<ProjectBootstrap> {
  if (!canExecuteRemoteProductMutation(input.bridge.getState())) {
    throw new RemoteProjectOverviewFailure(
      "offline",
      "Project Overview is stale until the remote session reconnects.",
    );
  }
  const connection = input.bridge.connection();
  if (connection === undefined || connection.session() === undefined) {
    throw new RemoteProjectOverviewFailure(
      "offline",
      "No authenticated remote session is available.",
    );
  }
  const response = await connection.authenticatedFetch({
    method: "GET",
    path: "/api/projects/bootstrap",
  });
  if (!response.ok) {
    throw new RemoteProjectOverviewFailure(
      response.status === 403 ? "rejected" : "unavailable",
      "Project bootstrap failed over the remote session.",
    );
  }
  try {
    return decodeProjectBootstrap(await response.json());
  } catch {
    throw new RemoteProjectOverviewFailure(
      "unavailable",
      "Project bootstrap returned an invalid response.",
    );
  }
}

export function isRemoteProjectOverviewFailure(
  error: unknown,
): error is RemoteProjectOverviewFailure {
  return error instanceof RemoteProjectOverviewFailure;
}
