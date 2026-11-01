import type { BrowserAutomationClient } from "@octant/client-runtime/browser-automation-client";
import type { ExtensionImportSource } from "@octant/contracts/browser-extensions";
import { useEffect, useState } from "react";
import { OctantConfirmDialog } from "../ui/base/OctantConfirmDialog";
import { OctantSelectField } from "../ui/base/OctantSelect";

export interface BrowserExtensionImportDialogProps {
  readonly client: Pick<BrowserAutomationClient, "manageExtensions">;
  readonly onClose: (outcome: string | undefined) => void;
}

type Sources =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly sources: ReadonlyArray<ExtensionImportSource> }
  | { readonly kind: "unavailable"; readonly message: string };

/**
 * Copies one extension out of another browser's profile on this Mac, on the
 * person's pick. The lists show names only; nothing is copied until Import is
 * pressed, and the copy follows the same path as a picked folder: installed, off
 * everywhere, never in a Private page. An extension Octant cannot run is listed
 * with the reason instead of being offered.
 */
export function BrowserExtensionImportDialog(props: BrowserExtensionImportDialogProps) {
  const { client } = props;
  const manage = client.manageExtensions;
  const [sources, setSources] = useState<Sources>({ kind: "loading" });
  const [browser, setBrowser] = useState("");
  const [sourceProfile, setSourceProfile] = useState("");
  const [extensionId, setExtensionId] = useState("");
  const [pending, setPending] = useState(false);

  function choose(
    all: ReadonlyArray<ExtensionImportSource>,
    nextBrowser: string,
    nextProfile: string | undefined,
  ): void {
    const source = all.find((entry) => entry.browser === nextBrowser);
    const profile =
      source?.profiles.find((entry) => entry.id === nextProfile) ?? source?.profiles[0];
    setBrowser(source?.browser ?? "");
    setSourceProfile(profile?.id ?? "");
    setExtensionId(
      profile?.extensions.find((extension) => extension.unsupportedReason === undefined)?.id ?? "",
    );
  }

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
        if (result.kind === "browser-extension-import-sources") {
          setSources({ kind: "ready", sources: result.sources });
          choose(result.sources, result.sources[0]?.browser ?? "", undefined);
        } else {
          setSources({
            kind: "unavailable",
            message:
              result.kind === "browser-extension-refused"
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

  const all = sources.kind === "ready" ? sources.sources : [];
  const chosenSource = all.find((entry) => entry.browser === browser);
  const chosenProfile = chosenSource?.profiles.find((entry) => entry.id === sourceProfile);
  const extensions = chosenProfile?.extensions ?? [];
  const supported = extensions.filter((extension) => extension.unsupportedReason === undefined);
  const unsupported = extensions.filter((extension) => extension.unsupportedReason !== undefined);
  const picked = supported.find((extension) => extension.id === extensionId);

  async function importExtension(): Promise<void> {
    if (manage === undefined || chosenSource === undefined || picked === undefined) return;
    setPending(true);
    let outcome: string;
    try {
      const result = await manage.call(client, {
        kind: "import",
        browser: chosenSource.browser,
        sourceProfile,
        sourceExtensionId: picked.id,
      });
      outcome =
        result.kind === "browser-extension-installed"
          ? `Imported ${result.extension.name} from ${chosenSource.label}. It is off until you enable it in a profile.`
          : result.kind === "browser-extension-refused"
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
      confirmDisabled={picked === undefined}
      confirmLabel="Import"
      details={
        sources.kind === "ready" && all.length > 0 ? (
          <div className="host-settings__controls">
            <OctantSelectField
              aria-label="Browser to import from"
              onValueChange={(value) => choose(all, value, undefined)}
              options={all.map((source) => ({ id: source.browser, label: source.label }))}
              value={browser}
            />
            <OctantSelectField
              aria-label="Profile to import from"
              onValueChange={(value) => choose(all, browser, value)}
              options={(chosenSource?.profiles ?? []).map((profile) => ({
                id: profile.id,
                label: profile.label,
              }))}
              value={sourceProfile}
            />
            {supported.length > 0 ? (
              <OctantSelectField
                aria-label="Extension to import"
                onValueChange={setExtensionId}
                options={supported.map((extension) => ({
                  id: extension.id,
                  label: `${extension.name} · ${extension.version}`,
                }))}
                value={extensionId}
              />
            ) : (
              <p>Nothing in this profile can be imported.</p>
            )}
            {unsupported.length > 0 ? (
              <ul aria-label="Extensions that cannot be imported">
                {unsupported.map((extension) => (
                  <li key={extension.id}>
                    {extension.name}: {extension.unsupportedReason}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : (
          <p>
            {sources.kind === "loading"
              ? "Looking for browsers on this Mac…"
              : sources.kind === "unavailable"
                ? sources.message
                : "No extensions were found in another browser on this Mac."}
          </p>
        )
      }
      onCancel={() => props.onClose(undefined)}
      onConfirm={() => void importExtension()}
      pending={pending}
      title="Import an extension from another browser"
    >
      Pick a browser on this Mac, one of its profiles, and an extension. Octant copies the extension
      into its own folder; it never opens that browser’s profile. The copy is off until you enable
      it in a profile, and it never runs in a Private page. Some extensions may not work here,
      because Octant’s browser supports only part of what Chrome extensions can do.
    </OctantConfirmDialog>
  );
}
