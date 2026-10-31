import type { SecretStoresClient } from "@octant/client-runtime/secret-stores-client";
import { createContext, useContext } from "react";

/**
 * The host's secret-store client, offered to any Settings page that can point
 * a key at a linked store (Providers) without threading it through every
 * component between. Absent off the host, where linking is not available.
 */
export const SecretStoresClientContext = createContext<SecretStoresClient | undefined>(undefined);

export function useSecretStoresClient(): SecretStoresClient | undefined {
  return useContext(SecretStoresClientContext);
}
