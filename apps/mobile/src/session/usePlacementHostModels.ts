import { useCallback, useEffect, useState } from "react";
import {
  fetchMobileModelOptions,
  type MobileModelOption,
  type MobileRemoteTransport,
} from "@octant/client-runtime";

export function usePlacementHostModels(transport: MobileRemoteTransport | undefined): {
  readonly options: ReadonlyArray<MobileModelOption>;
  readonly loading: boolean;
  readonly error: string | undefined;
  readonly refresh: () => Promise<void>;
} {
  const [options, setOptions] = useState<ReadonlyArray<MobileModelOption>>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const refresh = useCallback(async () => {
    if (transport === undefined) {
      setOptions([]);
      setError(undefined);
      return;
    }
    setLoading(true);
    setError(undefined);
    try {
      setOptions(await fetchMobileModelOptions(transport));
    } catch (cause) {
      setOptions([]);
      setError(cause instanceof Error ? cause.message : "Could not load host models.");
    } finally {
      setLoading(false);
    }
  }, [transport]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { options, loading, error, refresh };
}
