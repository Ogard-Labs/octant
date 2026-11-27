import { useState } from "react";
import {
  setMobileThreadRest,
  type MobileInboxRow,
  type MobileRemoteTransport,
  type MobileThreadRestAction,
} from "@octant/client-runtime";
import { hapticFailure, hapticSuccess } from "../ui/haptics";

/** Sends one row action to its computer, and what the computer said if it refused. */
export function useThreadRowAction(input: {
  readonly row: MobileInboxRow;
  readonly transport: MobileRemoteTransport | undefined;
  readonly onDone: (action: MobileThreadRestAction) => void;
  readonly onFailed: (message: string) => void;
}): { readonly busy: boolean; readonly run: (action: MobileThreadRestAction) => void } {
  const [busy, setBusy] = useState(false);
  const { row, transport } = input;
  return {
    busy,
    run: (action) => {
      if (transport === undefined || busy) return;
      setBusy(true);
      setMobileThreadRest({ transport, row, action })
        .then(
          (result) => {
            if (result.status === "refused") {
              hapticFailure();
              input.onFailed(result.message);
              return;
            }
            hapticSuccess();
            input.onDone(action);
          },
          () => input.onFailed("The host could not be reached. Nothing changed."),
        )
        .finally(() => setBusy(false));
    },
  };
}
