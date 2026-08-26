import type { AppleToolchainClient } from "@octant/client-runtime/apple-toolchain-client";
import type { AppleArtifactRequest } from "@octant/contracts/apple-toolchain-rpc";
import { useEffect, useState } from "react";

export function useAppleSimulatorScreen(options: {
  readonly client: AppleToolchainClient;
  readonly request?: AppleArtifactRequest;
  readonly enabled: boolean;
}): string | undefined {
  const { client, enabled, request } = options;
  const [screenUrl, setScreenUrl] = useState<string>();
  const reference = request?.reference;

  useEffect(() => {
    if (!enabled || request === undefined) {
      setScreenUrl(undefined);
      return;
    }
    const controller = new AbortController();
    let objectUrl: string | undefined;
    void client.readScreenshot(request, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.status === "failed") {
        setScreenUrl(undefined);
        return;
      }
      objectUrl = URL.createObjectURL(result.blob);
      setScreenUrl(objectUrl);
    });
    return () => {
      controller.abort();
      if (objectUrl !== undefined) URL.revokeObjectURL(objectUrl);
    };
  }, [client, enabled, reference, request]);

  return screenUrl;
}
