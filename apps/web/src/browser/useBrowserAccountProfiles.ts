import type { BrowserAutomationClient } from "@octant/client-runtime/browser-automation-client";
import type { BrowserProfileSummary } from "@octant/contracts/browser-profiles";
import { useEffect, useState } from "react";
const changed = "octant:browser-account-profiles-changed";
export const announceBrowserAccountProfilesChanged = (): void => {
  window.dispatchEvent(new Event(changed));
};

/** Read local names on entry, creation or focus; never poll every profile's disk size. */
export function useBrowserAccountProfiles(
  client: Pick<BrowserAutomationClient, "manageProfiles">,
  enabled: boolean,
): ReadonlyArray<BrowserProfileSummary> {
  const [view, setView] = useState<{
    readonly client: typeof client;
    readonly profiles: ReadonlyArray<BrowserProfileSummary>;
  }>();
  const manage = client.manageProfiles;
  useEffect(() => {
    if (!enabled || manage === undefined) return;
    const controller = new AbortController();
    let revision = 0;
    const refresh = () => {
      const request = ++revision;
      void manage
        .call(client, { kind: "list", includeSizes: false }, controller.signal)
        .then((result) => {
          if (!controller.signal.aborted && request === revision)
            setView({
              client,
              profiles:
                result.kind === "browser-profiles"
                  ? result.profiles.filter((entry) => entry.profile.kind === "account")
                  : [],
            });
        })
        .catch(() => {
          if (!controller.signal.aborted && request === revision) setView({ client, profiles: [] });
        });
    };
    refresh();
    window.addEventListener("focus", refresh);
    window.addEventListener(changed, refresh);
    return () => {
      controller.abort();
      window.removeEventListener("focus", refresh);
      window.removeEventListener(changed, refresh);
    };
  }, [client, manage, enabled]);
  return enabled && view?.client === client ? view.profiles : [];
}
