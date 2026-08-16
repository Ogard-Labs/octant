import type { DiscoveryCandidate, DiscoverySnapshot } from "@octant/contracts";
import {
  createDiscoveryClient,
  type DiscoveryClient,
} from "@octant/client-runtime/discovery-client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export interface DiscoveryControllerOptions {
  readonly serverUrl?: string;
  readonly windowCapability?: string;
  readonly client?: DiscoveryClient;
  readonly afterScan?: (snapshot: DiscoverySnapshot) => Promise<unknown> | unknown;
}

export function useDiscoveryController(options: DiscoveryControllerOptions) {
  const fallbackClient = useMemo(
    () =>
      options.serverUrl !== undefined && options.windowCapability !== undefined
        ? createDiscoveryClient({
            baseUrl: options.serverUrl,
            fetch: globalThis.fetch,
            windowCapability: options.windowCapability,
          })
        : undefined,
    [options.serverUrl, options.windowCapability],
  );
  const client = options.client ?? fallbackClient;
  const afterScan = options.afterScan;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [snapshot, setSnapshot] = useState<DiscoverySnapshot | undefined>(undefined);
  const [scanning, setScanning] = useState(false);
  const [connectingPaths, setConnectingPaths] = useState<ReadonlySet<string>>(new Set());
  const [message, setMessage] = useState<string | undefined>(undefined);
  const inFlightScan = useRef<Promise<DiscoverySnapshot | undefined> | undefined>(undefined);

  const scan = useCallback(async (): Promise<DiscoverySnapshot | undefined> => {
    if (client === undefined) {
      setMessage("Discovery is unavailable for this window.");
      return undefined;
    }
    if (inFlightScan.current !== undefined) return inFlightScan.current;
    setScanning(true);
    setMessage(undefined);
    const task = (async (): Promise<DiscoverySnapshot | undefined> => {
      try {
        const result = await client.scan();
        try {
          await afterScan?.(result);
        } catch (error) {
          if (mounted.current) {
            setMessage(
              typeof error === "object" && error !== null && "message" in error
                ? String(error.message)
                : "Provider inventory refresh failed after discovery scan.",
            );
          }
        }
        if (mounted.current) {
          setSnapshot(result);
        }
        return result;
      } catch (error) {
        if (mounted.current) {
          setMessage(
            typeof error === "object" && error !== null && "message" in error
              ? String(error.message)
              : "Discovery scan failed.",
          );
        }
        return undefined;
      } finally {
        inFlightScan.current = undefined;
        if (mounted.current) setScanning(false);
      }
    })();
    inFlightScan.current = task;
    return task;
  }, [afterScan, client]);

  const connect = useCallback(
    async (candidate: DiscoveryCandidate): Promise<boolean> => {
      if (client === undefined) {
        setMessage("Discovery is unavailable for this window.");
        return false;
      }
      setConnectingPaths((prev) => new Set(prev).add(candidate.binaryPath));
      setMessage(undefined);
      try {
        await client.connect({
          kind: "connect",
          driverKind: candidate.driverKind,
          binaryPath: candidate.binaryPath,
          displayName: candidate.displayName,
        });
        try {
          await scan();
        } catch {
          // Connect succeeded; inventory refresh is best-effort.
        }
        return true;
      } catch (error) {
        if (mounted.current) {
          setMessage(
            typeof error === "object" && error !== null && "message" in error
              ? String(error.message)
              : "Could not connect the detected runtime.",
          );
        }
        return false;
      } finally {
        if (mounted.current) {
          setConnectingPaths((prev) => {
            const next = new Set(prev);
            next.delete(candidate.binaryPath);
            return next;
          });
        }
      }
    },
    [client, scan],
  );

  return {
    snapshot,
    scanning,
    connectingPaths,
    ...(message !== undefined ? { message } : {}),
    scan,
    connect,
  };
}

export type DiscoveryController = ReturnType<typeof useDiscoveryController>;
