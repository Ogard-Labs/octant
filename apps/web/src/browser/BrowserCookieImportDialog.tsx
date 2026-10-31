import type { BrowserAutomationClient } from "@octant/client-runtime/browser-automation-client";
import type { BrowserProfileSummary, CookieImportSource } from "@octant/contracts/browser-profiles";
import { useEffect, useState } from "react";
import { OctantConfirmDialog } from "../ui/base/OctantConfirmDialog";
import { OctantSelectField } from "../ui/base/OctantSelect";

export interface BrowserCookieImportDialogProps {
  readonly client: Pick<BrowserAutomationClient, "manageProfiles">;
  readonly profile: BrowserProfileSummary;
  readonly onClose: (outcome: string | undefined) => void;
}

type Sources =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly sources: ReadonlyArray<CookieImportSource> }
  | { readonly kind: "unavailable"; readonly message: string };

/**
 * Copies one browser profile's cookies into one Octant profile, on the person's
 * pick. Nothing is read until Import is pressed: the lists show browser and
 * profile names only. macOS then asks for the browser's cookie key in its own
 * prompt, and a refusal imports nothing.
 */
export function BrowserCookieImportDialog(props: BrowserCookieImportDialogProps) {
  const { client } = props;
  const manage = client.manageProfiles;
  const [sources, setSources] = useState<Sources>({ kind: "loading" });
  const [browser, setBrowser] = useState("");
  const [sourceProfile, setSourceProfile] = useState("");
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let current = true;
    if (manage === undefined) {
      setSources({ kind: "unavailable", message: "Importing is not available here." });
      return undefined;
    }
    manage
      .call(client, { kind: "import-sources" })
      .then((result) => {
        if (!current) return;
        if (result.kind === "browser-cookie-sources") {
          setSources({ kind: "ready", sources: result.sources });
          const first = result.sources[0];
          setBrowser(first?.browser ?? "");
          setSourceProfile(first?.profiles[0]?.id ?? "");
        } else {
          setSources({
            kind: "unavailable",
            message:
              result.kind === "browser-profiles-refused"
                ? result.message
                : "Importing is not available here.",
          });
        }
      })
      .catch(() => {
        if (current) setSources({ kind: "unavailable", message: "Importing is unavailable." });
      });
    return () => {
      current = false;
    };
  }, [client, manage]);

  const chosen =
    sources.kind === "ready" ? sources.sources.find((s) => s.browser === browser) : undefined;
  const ready = chosen !== undefined && sourceProfile !== "";

  async function importCookies(): Promise<void> {
    if (manage === undefined || chosen === undefined) return;
    setPending(true);
    let outcome: string;
    try {
      const result = await manage.call(client, {
        kind: "import-cookies",
        profile: props.profile.profile,
        browser: chosen.browser,
        sourceProfile,
      });
      outcome =
        result.kind === "browser-cookies-imported"
          ? `Imported ${String(result.imported)} cookies from ${chosen.label} into ${props.profile.label}${
              result.skipped > 0 ? ` (${String(result.skipped)} left behind)` : ""
            }.`
          : result.kind === "browser-profiles-refused"
            ? result.message
            : "Nothing was imported.";
    } catch {
      outcome = "Nothing was imported.";
    }
    setPending(false);
    props.onClose(outcome);
  }

  return (
    <OctantConfirmDialog
      confirmDisabled={!ready}
      confirmLabel="Import"
      details={
        sources.kind === "ready" && sources.sources.length > 0 ? (
          <div className="host-settings__controls">
            <OctantSelectField
              aria-label="Browser to import from"
              onValueChange={(value) => {
                setBrowser(value);
                setSourceProfile(
                  sources.sources.find((source) => source.browser === value)?.profiles[0]?.id ?? "",
                );
              }}
              options={sources.sources.map((source) => ({
                id: source.browser,
                label: source.label,
              }))}
              value={browser}
            />
            <OctantSelectField
              aria-label="Profile to import from"
              onValueChange={setSourceProfile}
              options={(chosen?.profiles ?? []).map((profile) => ({
                id: profile.id,
                label: profile.label,
              }))}
              value={sourceProfile}
            />
          </div>
        ) : (
          <p>
            {sources.kind === "loading"
              ? "Looking for browsers on this Mac…"
              : sources.kind === "unavailable"
                ? sources.message
                : "No other browser with cookies was found on this Mac."}
          </p>
        )
      }
      onCancel={() => props.onClose(undefined)}
      onConfirm={() => void importCookies()}
      pending={pending}
      title={`Import cookies into ${props.profile.label}`}
    >
      Pick a browser on this Mac and one of its profiles. Octant copies that profile’s cookies into
      this profile, only now and only on this Mac, and sends them nowhere. macOS will ask you to
      allow access to the browser’s cookie key; if you decline, nothing is imported.
    </OctantConfirmDialog>
  );
}
