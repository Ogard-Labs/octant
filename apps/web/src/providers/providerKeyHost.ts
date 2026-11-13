import type { OctantHostBridge } from "../shell/hostBridge";

/**
 * What the Providers page needs of a host to store, replace and clear a
 * provider key: the desktop bridge in a local window, and the session's
 * credential client in a browser the host's own person paired. The optional
 * members are the desktop's alone and are absent over a session.
 */
export type ProviderKeyHost = Pick<
  OctantHostBridge,
  | "providerCredentialStatus"
  | "setProviderCredential"
  | "clearProviderCredential"
  | "listProviderApiKeys"
  | "addProviderApiKey"
  | "renameProviderApiKey"
  | "replaceProviderApiKey"
  | "removeProviderApiKey"
  | "setActiveProviderApiKey"
  | "moveProviderApiKey"
> &
  Partial<
    Pick<
      OctantHostBridge,
      "openBrowserExternal" | "getManagedToolsStatus" | "checkManagedToolUpdates"
    >
  >;
