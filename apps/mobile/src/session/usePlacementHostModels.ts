import { useCallback, useEffect, useState } from "react";
import {
  fetchMobileProviderCatalog,
  normalizeMobileModelOptions,
  normalizeMobileProviderDirectory,
  type MobileModelOption,
  type MobileProviderDirectoryEntry,
  type MobileRemoteTransport,
} from "@octant/client-runtime";

export function usePlacementHostModels(transport: MobileRemoteTransport | undefined): {
  readonly options: ReadonlyArray<MobileModelOption>;
  readonly providerDirectory: ReadonlyArray<MobileProviderDirectoryEntry>;
  readonly loading: boolean;
  readonly error: string | undefined;
  readonly refresh: () => Promise<void>;
} {
  const [options, setOptions] = useState<ReadonlyArray<MobileModelOption>>([]);
  const [providerDirectory, setProviderDirectory] = useState<
    ReadonlyArray<MobileProviderDirectoryEntry>
  >([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const refresh = useCallback(async () => {
    if (transport === undefined) {
      setOptions([]);
      setProviderDirectory([]);
      setError(undefined);
      return;
    }
    setLoading(true);
    setError(undefined);
    try {
      const catalog = await fetchMobileProviderCatalog(transport);
      setOptions(normalizeMobileModelOptions(catalog));
      setProviderDirectory(normalizeMobileProviderDirectory(catalog));
    } catch (cause) {
      setOptions([]);
      setProviderDirectory([]);
      setError(cause instanceof Error ? cause.message : "Could not load host models.");
    } finally {
      setLoading(false);
    }
  }, [transport]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { options, providerDirectory, loading, error, refresh };
}
