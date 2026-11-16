import { createNativeHarnessClient, type NativeHarnessClient } from "@octant/client-runtime";
import type { SeesImagesAvailability } from "@octant/contracts";
import { useEffect, useMemo, useState } from "react";

/**
 * Whether a composer may take an image for its thread's model.
 *
 * `readsImages` is what the picker says about the model. When it says the
 * model cannot read images, the host is asked whether Sees images could
 * describe one for this Project; while that answer is out, or when it
 * refuses, the composer refuses as before, and the turn still decides at
 * send. Returns `false` with the host's reason, `true` when Sees images
 * covers the model, and the picker's own answer otherwise.
 */
export function useSeesImages(options: {
  readonly readsImages: boolean | undefined;
  readonly serverUrl?: string | undefined;
  readonly windowCapability?: string | undefined;
  readonly projectId?: string | undefined;
  readonly providerInstanceId?: string | undefined;
  readonly modelId?: string | undefined;
  readonly client?: Pick<NativeHarnessClient, "seesImages">;
}): { readonly takesImages: boolean | undefined; readonly refusal?: string } {
  const { readsImages, serverUrl, windowCapability, projectId, providerInstanceId, modelId } =
    options;
  const injected = options.client;
  const client = useMemo(() => {
    if (injected !== undefined) return injected;
    if (serverUrl === undefined || windowCapability === undefined) return undefined;
    try {
      return createNativeHarnessClient({ baseUrl: serverUrl, fetch, windowCapability });
    } catch {
      return undefined;
    }
  }, [injected, serverUrl, windowCapability]);
  const [answer, setAnswer] = useState<
    { readonly key: string; readonly availability: SeesImagesAvailability } | undefined
  >(undefined);
  const key = `${projectId ?? ""}|${providerInstanceId ?? ""}|${modelId ?? ""}`;
  const asks =
    readsImages === false &&
    client !== undefined &&
    providerInstanceId !== undefined &&
    modelId !== undefined;
  useEffect(() => {
    if (!asks || client === undefined || providerInstanceId === undefined || modelId === undefined)
      return;
    const controller = new AbortController();
    void client
      .seesImages(
        {
          providerInstanceId,
          modelId,
          ...(projectId === undefined ? {} : { projectId }),
        },
        controller.signal,
      )
      .then((availability) => {
        if (!controller.signal.aborted) setAnswer({ key, availability });
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [asks, client, key, modelId, projectId, providerInstanceId]);
  if (readsImages !== false) return { takesImages: readsImages };
  const current = answer?.key === key ? answer.availability : undefined;
  if (current?.kind === "available") return { takesImages: true };
  return current === undefined
    ? { takesImages: false }
    : { takesImages: false, refusal: current.reason };
}
