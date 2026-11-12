import type { ExtensionClient } from "@octant/client-runtime/extension-client";
import type {
  UserAddedMcpServerRequest,
  ExtensionCommandFailure,
} from "@octant/contracts/extension-rpc";
import { PAPER_LOCAL_SETUP, type ConnectorCatalogEntry } from "@octant/domain";

export type ConnectResult =
  | {
      readonly kind: "connected";
      readonly extensionId: string | undefined;
      readonly componentId: string | undefined;
    }
  | { readonly kind: "failed"; readonly failure: ExtensionCommandFailure };

/**
 * Connect a catalog connector: the host adds its server, trusts it and turns
 * it on after one confirmation, through the ordinary generated-server flow. The host decides; a
 * refusal comes back as a value. Connectors view and Library both call this,
 * so the two cannot drift apart.
 */
export async function connectConnector(
  client: Pick<ExtensionClient, "addUserMcpServer">,
  entry: Pick<ConnectorCatalogEntry, "id" | "displayName" | "url" | "auth">,
  secret?: string,
): Promise<ConnectResult> {
  if (entry.auth.kind === "command") {
    // The host rebuilds the program from the catalog; the request names the
    // entry and carries only the one secret the person typed.
    return addServer(client, {
      name: entry.displayName,
      connectorId: entry.id,
      server: {
        type: "stdio",
        command: "node",
        args: [],
        env:
          secret === undefined
            ? []
            : [{ name: entry.auth.secret.name, value: secret, secret: true }],
      },
    });
  }
  return addServer(client, {
    name: entry.displayName,
    connectorId: entry.id,
    server: {
      type: "streamable-http",
      url: entry.url,
      headers:
        entry.auth.kind === "key" && secret !== undefined
          ? [
              {
                name: entry.auth.header,
                value: entry.auth.prefix === undefined ? secret : `${entry.auth.prefix} ${secret}`,
                secret: true,
              },
            ]
          : [],
    },
  });
}

/** The local setup uses the ordinary generated MCP package and its existing authority checks. */
export function connectPaperLocalServer(
  client: Pick<ExtensionClient, "addUserMcpServer">,
): Promise<ConnectResult> {
  return addServer(client, {
    name: PAPER_LOCAL_SETUP.name,
    localSetupId: "paper",
    server: {
      type: "streamable-http",
      url: PAPER_LOCAL_SETUP.url,
      headers: [],
    },
  });
}

async function addServer(
  client: Pick<ExtensionClient, "addUserMcpServer">,
  request: UserAddedMcpServerRequest,
): Promise<ConnectResult> {
  try {
    const result = await client.addUserMcpServer(request);
    if (result.kind === "extension-command-failed")
      return { kind: "failed", failure: result.failure };
    const added = result.kind === "extension-state-updated" ? result.addedPackage : undefined;
    return {
      kind: "connected",
      extensionId: added === undefined ? undefined : String(added.extensionId),
      componentId: added?.componentId === undefined ? undefined : String(added.componentId),
    };
  } catch (error) {
    return {
      kind: "failed",
      failure: {
        category: "unavailable",
        message:
          error instanceof Error
            ? error.message
            : "Extensions could not be reached. Restart Octant and try again.",
      },
    };
  }
}
