import { useEffect, useState } from "react";

export interface DesktopWindowAuthorityBridge {
  readonly subscribeProjectWindowCapability?: (
    listener: (capability: string) => void,
  ) => () => void;
}

interface ReplacementAuthority {
  readonly bridge: DesktopWindowAuthorityBridge;
  readonly initialCapability: string;
  readonly capability: string;
}

export function useDesktopWindowAuthority(
  initialCapability: string | undefined,
  bridge: DesktopWindowAuthorityBridge | undefined,
): string | undefined {
  const [replacement, setReplacement] = useState<ReplacementAuthority>();
  const replacementIsCurrent =
    replacement !== undefined &&
    replacement.bridge === bridge &&
    replacement.initialCapability === initialCapability;
  const capability = replacementIsCurrent ? replacement.capability : initialCapability;

  useEffect(() => {
    setReplacement(undefined);
    if (initialCapability === undefined || bridge?.subscribeProjectWindowCapability === undefined) {
      return;
    }
    return bridge.subscribeProjectWindowCapability((next) => {
      setReplacement({ bridge, initialCapability, capability: next });
    });
  }, [bridge, initialCapability]);

  return capability;
}
