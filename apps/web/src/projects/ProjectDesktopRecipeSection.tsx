import type { DesktopPaneClient } from "@octant/client-runtime/desktop-pane-client";
import {
  decodeDesktopMachineId,
  decodeDesktopPlacementId,
  decodeDesktopProviderId,
  type DesktopPaneAnswer,
  type DesktopRecipe,
  type DesktopRecipeKeyChange,
  type LeasableDesktopProvider,
} from "@octant/contracts/desktop-lease";
import type { ProjectSummary } from "@octant/contracts/projects";
import { useEffect, useRef, useState } from "react";
import { providerCapability, setupMessage } from "../desktop/desktopPaneModel";
import { hostCredentialStore, useHostPlatform } from "../platform";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantConfirmDialog } from "../ui/base/OctantConfirmDialog";
import { OctantFieldError } from "../ui/base/OctantField";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantSelectField, type OctantSelectOption } from "../ui/base/OctantSelect";

type CodeProjectSummary = Extract<ProjectSummary, { readonly type: "code" }>;

export interface ProjectDesktopRecipeSectionProps {
  readonly project: CodeProjectSummary;
  /** Asks the host which providers a recipe may name; absent when this window has no route to it. */
  readonly client?: Pick<DesktopPaneClient, "request">;
  /**
   * `null` removes the recipe. `key` enters or removes the key a cloud
   * provider reads; the host keeps it in its credential store, never here.
   */
  readonly onChange: (
    recipe: DesktopRecipe | null,
    key?: DesktopRecipeKeyChange,
  ) => Promise<boolean>;
  readonly disabled?: boolean;
}

/** The lease limits a new recipe starts from: a 30-minute lease, at most four hours, idle after 15. */
const DEFAULT_LIMITS = { leaseMinutes: 30, maximumLeaseMinutes: 240, idleMinutes: 15 } as const;

const SCREEN_SIZES: ReadonlyArray<DesktopRecipe["screen"]> = [
  { width: 1024, height: 768 },
  { width: 1280, height: 800 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
];
const DEFAULT_SCREEN = "1280x800";

/**
 * The lease limits as choices rather than free numbers: each list stays inside
 * the four-hour bound the host enforces, and a saved value off the list is
 * offered too, so opening the editor never changes a recipe by itself.
 */
const MINUTE_FIELDS: ReadonlyArray<{
  readonly key: "leaseMinutes" | "maximumLeaseMinutes" | "idleMinutes";
  readonly label: string;
  readonly description: string;
  readonly presets: ReadonlyArray<number>;
}> = [
  {
    key: "leaseMinutes",
    label: "Lasts",
    description: "How long a new desktop lasts",
    presets: [15, 30, 60, 120],
  },
  {
    key: "maximumLeaseMinutes",
    label: "Longest",
    description: "Longest a desktop may run with extensions",
    presets: [30, 60, 120, 240],
  },
  {
    key: "idleMinutes",
    label: "Idle",
    description: "How long a desktop may sit unused",
    presets: [5, 15, 30, 60],
  },
];

function minuteLabel(minutes: number): string {
  if (minutes % 60 === 0) return minutes === 60 ? "1 hour" : `${minutes / 60} hours`;
  return `${minutes} minutes`;
}

function minuteOptions(
  presets: ReadonlyArray<number>,
  current: number,
): ReadonlyArray<OctantSelectOption> {
  const values = presets.includes(current) ? presets : [...presets, current].sort((a, b) => a - b);
  return values.map((minutes) => ({ id: String(minutes), label: minuteLabel(minutes) }));
}

interface RecipeDraft {
  readonly providerId: string;
  /** The provider's placement, or empty for a provider that offers none. */
  readonly placementId: string;
  /** The person's computer, for a placement that chooses one; empty until one is chosen. */
  readonly machineId: string;
  readonly machineName: string;
  readonly screen: string;
  readonly leaseMinutes: number;
  readonly maximumLeaseMinutes: number;
  readonly idleMinutes: number;
  /** The person's cost per hour in dollars as typed, for a desktop that bills them. */
  readonly hourlyCost: string;
}

/**
 * Dollars as a person types them (`0.40`, `$1.25`) in whole cents, or
 * undefined for anything else. The contract takes at least a cent and at
 * most $10,000 an hour.
 */
function centsOf(typed: string): number | undefined {
  const match = /^\$?\s*(\d{1,5})(?:\.(\d{1,2}))?$/.exec(typed.trim());
  if (match === null) return undefined;
  const cents = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return cents >= 1 && cents <= 1_000_000 ? cents : undefined;
}

const dollarsOf = (cents: number) => (cents / 100).toFixed(2);

type OfferedProviders =
  | { readonly status: "loading" }
  | { readonly status: "loaded"; readonly providers: ReadonlyArray<LeasableDesktopProvider> }
  | { readonly status: "failed" };

type ListedMachines = Extract<
  DesktopPaneAnswer,
  { readonly status: "recipe-machines" }
>["machines"];

type OfferedMachines =
  | { readonly status: "loading" }
  | { readonly status: "loaded"; readonly machines: ListedMachines }
  | { readonly status: "failed" };

type RecipeKeyAnswer = Extract<DesktopPaneAnswer, { readonly status: "recipe-key" }>;

type SavedKey =
  | { readonly status: "loading" }
  | {
      readonly status: "loaded";
      readonly key: RecipeKeyAnswer["key"];
      readonly store: RecipeKeyAnswer["store"];
      readonly releasing: boolean;
    }
  | { readonly status: "failed" };

const KEY_RELEASE_POLL_MS = 5_000;

const screenId = (screen: DesktopRecipe["screen"]) => `${screen.width}x${screen.height}`;

/** The placement a provider starts from: its first, or none when it offers none. */
function firstPlacement(
  providerId: string,
  providers: ReadonlyArray<LeasableDesktopProvider>,
): string {
  const provider = providers.find((candidate) => String(candidate.providerId) === providerId);
  return String(provider?.placements?.[0]?.placementId ?? "");
}

function draftOf(
  saved: DesktopRecipe | undefined,
  providers: ReadonlyArray<LeasableDesktopProvider>,
): RecipeDraft {
  if (saved === undefined) {
    const providerId = String(
      (providers.find((provider) => provider.needsSetup === undefined) ?? providers[0])
        ?.providerId ?? "",
    );
    return {
      providerId,
      placementId: firstPlacement(providerId, providers),
      machineId: "",
      machineName: "",
      screen: DEFAULT_SCREEN,
      ...DEFAULT_LIMITS,
      hourlyCost: "",
    };
  }
  return {
    providerId: String(saved.providerId),
    placementId: String(saved.placementId ?? ""),
    machineId: String(saved.machine?.machineId ?? ""),
    machineName: saved.machine?.displayName ?? "",
    screen: screenId(saved.screen),
    leaseMinutes: saved.leaseMinutes,
    maximumLeaseMinutes: saved.maximumLeaseMinutes,
    idleMinutes: saved.idleMinutes,
    hourlyCost: saved.hourlyCostUsdCents === undefined ? "" : dollarsOf(saved.hourlyCostUsdCents),
  };
}

function sameDraft(left: RecipeDraft, right: RecipeDraft): boolean {
  return (
    left.providerId === right.providerId &&
    left.placementId === right.placementId &&
    left.machineId === right.machineId &&
    left.screen === right.screen &&
    left.leaseMinutes === right.leaseMinutes &&
    left.maximumLeaseMinutes === right.maximumLeaseMinutes &&
    left.idleMinutes === right.idleMinutes &&
    centsOf(left.hourlyCost) === centsOf(right.hourlyCost)
  );
}

/**
 * The recipe a draft saves. The network is always off: a desktop on this host
 * gets network only by sharing the host's own, which the host refuses. An
 * image and a credential belong to cloud providers, which this editor does
 * not offer yet, so a saved recipe keeps whatever it already had. A provider
 * whose daemon holds the person's sign-in takes its placement in place of a
 * credential, so none is kept for it.
 */
function recipeOf(
  draft: RecipeDraft,
  saved: DesktopRecipe | undefined,
  providers: ReadonlyArray<LeasableDesktopProvider>,
): DesktopRecipe {
  const [width, height] = draft.screen.split("x").map(Number);
  const hourlyCostUsdCents = draftBilled(draft, providers) ? centsOf(draft.hourlyCost) : undefined;
  const daemon = providers.some(
    (provider) => String(provider.providerId) === draft.providerId && provider.daemon === true,
  );
  const keep =
    saved !== undefined && String(saved.providerId) === draft.providerId
      ? {
          ...(saved.image === undefined ? {} : { image: saved.image }),
          ...(saved.credentialRef === undefined || daemon
            ? {}
            : { credentialRef: saved.credentialRef }),
        }
      : {};
  return {
    providerId: decodeDesktopProviderId(draft.providerId),
    ...keep,
    ...(draft.placementId === ""
      ? {}
      : { placementId: decodeDesktopPlacementId(draft.placementId) }),
    ...(draft.machineId === ""
      ? {}
      : {
          machine: {
            machineId: decodeDesktopMachineId(draft.machineId),
            displayName: draft.machineName,
          },
        }),
    screen: { width: width ?? 1280, height: height ?? 800 },
    network: "none",
    leaseMinutes: draft.leaseMinutes,
    maximumLeaseMinutes: draft.maximumLeaseMinutes,
    idleMinutes: draft.idleMinutes,
    ...(hourlyCostUsdCents === undefined ? {} : { hourlyCostUsdCents }),
  };
}

/** Whether the draft's provider, or its placement when it has one, bills the person. */
function draftBilled(
  draft: RecipeDraft,
  providers: ReadonlyArray<LeasableDesktopProvider>,
): boolean {
  const provider = providers.find((candidate) => String(candidate.providerId) === draft.providerId);
  const placement = provider?.placements?.find(
    (candidate) => String(candidate.placementId) === draft.placementId,
  );
  return placement?.billed ?? provider?.billed ?? false;
}

/**
 * A Code Project's disposable desktop recipe: the provider, screen, and lease
 * limits its threads' desktops start from. The host decides which providers a
 * recipe may name and validates the recipe again when it is saved; this only
 * offers what the host said it offers.
 */
export function ProjectDesktopRecipeSection(props: ProjectDesktopRecipeSectionProps) {
  const saved = props.project.desktopRecipe;
  const [offered, setOffered] = useState<OfferedProviders>({ status: "loading" });
  useEffect(() => {
    const client = props.client;
    if (client === undefined) {
      setOffered({ status: "failed" });
      return undefined;
    }
    const controller = new AbortController();
    setOffered({ status: "loading" });
    client.request({ kind: "recipe-providers" }, controller.signal).then(
      (answer) => {
        if (controller.signal.aborted) return;
        setOffered(
          answer.status === "recipe-providers"
            ? { status: "loaded", providers: answer.providers }
            : { status: "failed" },
        );
      },
      () => {
        if (!controller.signal.aborted) setOffered({ status: "failed" });
      },
    );
    return () => controller.abort();
  }, [props.client]);
  const providers = offered.status === "loaded" ? offered.providers : [];

  // Asked only when a person has a placement that chooses a computer in view:
  // listing the person's computers asks their provider, which nothing else
  // in this editor does.
  const [offeredMachines, setOfferedMachines] = useState<OfferedMachines>({ status: "loading" });

  const [draft, setDraft] = useState<RecipeDraft>(() => draftOf(saved, providers));
  // The recipe and provider list the draft was last filled from. When another
  // window saves a recipe, or the provider list arrives, the draft follows it;
  // otherwise a save would send a stale draft under the refreshed version.
  const filledKey = `${JSON.stringify(saved ?? null)}|${providers.map((p) => p.providerId).join(",")}`;
  const [filledFrom, setFilledFrom] = useState(filledKey);
  if (filledFrom !== filledKey) {
    setFilledFrom(filledKey);
    setDraft(draftOf(saved, providers));
  }
  const [pending, setPending] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [confirmKeyRemoval, setConfirmKeyRemoval] = useState(false);
  // The key field is never React state: the value is read once when the
  // person saves, sent to the host, and cleared, so it is not held for a
  // retry or rendered back.
  const keyInput = useRef<HTMLInputElement>(null);
  const [keyTyped, setKeyTyped] = useState(false);
  const hostPlatform = useHostPlatform();
  const disabled = props.disabled === true || pending;

  const providerOptions: ReadonlyArray<OctantSelectOption> = [
    ...providers.map((provider) => ({
      id: String(provider.providerId),
      // A provider that needs setup is listed so the person sees why, but a
      // recipe cannot move to it; one already saved on it stays editable.
      label:
        provider.needsSetup === undefined
          ? provider.displayName
          : `${provider.displayName} (needs setup)`,
      ...(provider.needsSetup !== undefined &&
      String(saved?.providerId ?? "") !== String(provider.providerId)
        ? { disabled: true }
        : {}),
    })),
    // A saved provider the host no longer offers stays visible, so the person
    // sees why the recipe cannot start a desktop, but cannot be chosen again.
    ...(saved === undefined ||
    providers.some((provider) => String(provider.providerId) === String(saved.providerId))
      ? []
      : [
          {
            id: String(saved.providerId),
            label: `${String(saved.providerId)} (not available on this host)`,
            disabled: true,
          },
        ]),
  ];
  const screenOptions: ReadonlyArray<OctantSelectOption> = [
    ...SCREEN_SIZES.map((screen) => ({
      id: screenId(screen),
      label: `${screen.width} × ${screen.height}`,
    })),
    ...(saved === undefined ||
    SCREEN_SIZES.some((screen) => screenId(screen) === screenId(saved.screen))
      ? []
      : [{ id: screenId(saved.screen), label: `${saved.screen.width} × ${saved.screen.height}` }]),
  ];

  const draftProvider = providers.find(
    (provider) => String(provider.providerId) === draft.providerId,
  );
  const providerOffered = draftProvider !== undefined;
  const placements = draftProvider?.placements ?? [];
  const machinesKey =
    draftProvider !== undefined &&
    placements.some(
      (placement) =>
        String(placement.placementId) === draft.placementId && placement.choosesMachine === true,
    )
      ? `${draft.providerId}|${draft.placementId}`
      : undefined;
  useEffect(() => {
    const client = props.client;
    if (machinesKey === undefined) return undefined;
    if (client === undefined) {
      setOfferedMachines({ status: "failed" });
      return undefined;
    }
    const [providerId = "", placementId = ""] = machinesKey.split("|");
    const controller = new AbortController();
    setOfferedMachines({ status: "loading" });
    client
      .request(
        {
          kind: "recipe-machines",
          providerId: decodeDesktopProviderId(providerId),
          placementId: decodeDesktopPlacementId(placementId),
        },
        controller.signal,
      )
      .then(
        (answer) => {
          if (controller.signal.aborted) return;
          setOfferedMachines(
            answer.status === "recipe-machines"
              ? { status: "loaded", machines: answer.machines }
              : { status: "failed" },
          );
        },
        () => {
          if (!controller.signal.aborted) setOfferedMachines({ status: "failed" });
        },
      );
    return () => controller.abort();
  }, [props.client, machinesKey]);
  // A provider that offers placements is leased only on one of them, and one
  // that offers none only on its own terms.
  const placementOffered =
    placements.length === 0
      ? draft.placementId === ""
      : placements.some((placement) => String(placement.placementId) === draft.placementId);
  const placementOptions: ReadonlyArray<OctantSelectOption> = [
    ...placements.map((placement) => ({
      id: String(placement.placementId),
      label: placement.displayName,
    })),
    // A saved placement the host no longer offers stays visible but cannot be chosen again.
    ...(draft.placementId === "" ||
    placements.some((placement) => String(placement.placementId) === draft.placementId)
      ? []
      : [
          {
            id: draft.placementId,
            label: `${draft.placementId} (not available on this host)`,
            disabled: true,
          },
        ]),
  ];
  // A placement that runs on one of the person's computers names which one,
  // from those the host lists now; a saved one stays visible if it is not
  // listed, but cannot be chosen again.
  const choosesMachine =
    placements.find((placement) => String(placement.placementId) === draft.placementId)
      ?.choosesMachine === true;
  const listedMachines = offeredMachines.status === "loaded" ? offeredMachines.machines : [];
  const machineListed = listedMachines.some(
    (machine) => String(machine.machineId) === draft.machineId,
  );
  const machineOptions: ReadonlyArray<OctantSelectOption> = [
    ...listedMachines.map((machine) => ({
      id: String(machine.machineId),
      label: machine.online ? machine.displayName : `${machine.displayName} (not answering now)`,
    })),
    ...(draft.machineId === "" || machineListed
      ? []
      : [
          {
            id: draft.machineId,
            label:
              offeredMachines.status === "loaded"
                ? `${draft.machineName} (not listed now)`
                : draft.machineName,
            disabled: true,
          },
        ]),
  ];
  const machineOffered = choosesMachine ? machineListed : draft.machineId === "";
  // A cloud provider that no signed-in daemon runs leases on the person's
  // account through a key Octant keeps in the host credential store. The key
  // a saved recipe names carries over only while it stays on that provider
  // and placement; anywhere else needs a key of its own.
  const takesKey =
    draftProvider !== undefined &&
    draftProvider.daemon !== true &&
    (placements.find((placement) => String(placement.placementId) === draft.placementId)
      ?.locality ?? draftProvider.locality) === "cloud";
  const keyCarries =
    saved !== undefined &&
    String(saved.providerId) === draft.providerId &&
    String(saved.placementId ?? "") === draft.placementId;
  const savedKeyRef = keyCarries ? String(saved.credentialRef ?? "") : "";
  const [savedKey, setSavedKey] = useState<SavedKey>({ status: "loading" });
  // Teardown and the key sweep change nothing the query below depends on, so
  // while a retired key is waiting the answer is asked for again.
  const [keyAsked, setKeyAsked] = useState(0);
  const waitingOnRelease = savedKey.status === "loaded" && savedKey.releasing;
  const keyQuery = takesKey
    ? `${String(props.project.id)}|${savedKeyRef}|${String(props.project.version)}`
    : undefined;
  useEffect(() => {
    const client = props.client;
    if (keyQuery === undefined) return undefined;
    if (client === undefined) {
      setSavedKey({ status: "failed" });
      return undefined;
    }
    const controller = new AbortController();
    // A repeat ask keeps the last answer on screen rather than flickering.
    setSavedKey((current) => (keyAsked > 0 ? current : { status: "loading" }));
    client
      .request({ kind: "recipe-key", projectId: String(props.project.id) }, controller.signal)
      .then(
        (answer) => {
          if (controller.signal.aborted) return;
          setSavedKey(
            answer.status === "recipe-key"
              ? {
                  status: "loaded",
                  key: answer.key,
                  store: answer.store,
                  releasing: answer.releasing === true,
                }
              : { status: "failed" },
          );
        },
        () => {
          if (!controller.signal.aborted) setSavedKey({ status: "failed" });
        },
      );
    return () => controller.abort();
  }, [props.client, props.project.id, keyQuery, keyAsked]);
  useEffect(() => {
    if (!waitingOnRelease) return undefined;
    const timer = setInterval(() => setKeyAsked((count) => count + 1), KEY_RELEASE_POLL_MS);
    return () => clearInterval(timer);
  }, [waitingOnRelease]);
  const keyStoreUnavailable = savedKey.status === "loaded" && savedKey.store === "unavailable";
  // What the key field says: a recipe moving to this provider has no key
  // yet whatever the host holds for another one.
  const keyState =
    savedKey.status !== "loaded" ? savedKey.status : keyCarries ? savedKey.key : "none";
  const providerName = draftProvider?.displayName ?? "the provider";
  const keyMessage = keyStoreUnavailable
    ? "This host has no credential store Octant can reach, so it can't keep a key. Desktops on this provider can't start until it does."
    : keyState === "loading"
      ? "Checking the key…"
      : keyState === "failed"
        ? "This window can't ask the host about the key."
        : keyState === "saved"
          ? `Key saved in ${hostCredentialStore(hostPlatform)}. Enter a new one to replace it.`
          : keyState === "missing"
            ? `The saved key is no longer in ${hostCredentialStore(hostPlatform)}. Enter it again.`
            : keyState === "rejected"
              ? `${providerName} refused this key when a desktop last started. Enter a new one.`
              : `No key saved. Desktops can't start until you enter your ${providerName} API key.`;
  const keyReleasing = savedKey.status === "loaded" && savedKey.releasing;
  const keyReady = !takesKey || keyCarries || keyTyped;
  const limitsRefusal =
    draft.leaseMinutes > draft.maximumLeaseMinutes
      ? "A desktop can't start with longer than its longest run."
      : undefined;
  // A desktop that bills the person is estimated from their own figure
  // before it starts; Octant knows no provider's price.
  const billed = draftBilled(draft, providers);
  const costRefusal =
    billed && draft.hourlyCost.trim() !== "" && centsOf(draft.hourlyCost) === undefined
      ? "Enter a cost per hour in dollars, such as 0.40."
      : undefined;
  const costReady = !billed || centsOf(draft.hourlyCost) !== undefined;
  const unchanged = saved !== undefined && sameDraft(draft, draftOf(saved, providers));
  const providerSetUp =
    draftProvider?.needsSetup === undefined || String(saved?.providerId ?? "") === draft.providerId;
  const canSave =
    !disabled &&
    providerOffered &&
    providerSetUp &&
    placementOffered &&
    machineOffered &&
    limitsRefusal === undefined &&
    costReady &&
    keyReady &&
    !(unchanged && !keyTyped);

  async function commit(next: DesktopRecipe | null, key?: DesktopRecipeKeyChange): Promise<void> {
    setPending(true);
    try {
      await (key === undefined ? props.onChange(next) : props.onChange(next, key));
    } finally {
      setPending(false);
    }
  }

  /** Reads the typed key once and clears the field, whatever the host answers. */
  function takeTypedKey(): DesktopRecipeKeyChange | undefined {
    const typed = keyInput.current?.value.trim() ?? "";
    if (keyInput.current !== null) keyInput.current.value = "";
    setKeyTyped(false);
    return takesKey && typed !== "" ? { action: "enter", key: typed } : undefined;
  }

  const headingId = `desktop-recipe-${props.project.id}`;
  return (
    <section aria-labelledby={headingId} className="project-provider-policy project-desktop-recipe">
      <div className="project-provider-policy__header">
        <div>
          <h2 id={headingId}>Disposable desktop</h2>
          <p>
            The throwaway Linux desktop this Project's Code threads start from the Desktop tool. It
            has no network and none of this host's files, only what an agent sends it. Removing the
            recipe or changing its provider ends this Project's running desktops.
          </p>
        </div>
      </div>
      {offered.status === "loading" ? (
        <p className="project-provider-policy__empty" role="status">
          Checking which desktop providers this host offers…
        </p>
      ) : offered.status === "failed" ? (
        <p className="project-provider-policy__empty" role="status">
          This window can't ask the host which desktop providers it offers.
        </p>
      ) : providers.length === 0 ? (
        <p className="project-provider-policy__empty" role="status">
          No desktop provider is ready on this host. A Linux host offers its own once Bubblewrap,
          Xvfb, xdotool, and ImageMagick are installed and Octant restarts.
        </p>
      ) : null}
      {providerOptions.length === 0 ? null : (
        <>
          <label className="project-provider-policy__mode">
            <span>Provider</span>
            <OctantSelectField
              aria-label="Desktop provider"
              disabled={disabled}
              onValueChange={(providerId) =>
                setDraft((current) => ({
                  ...current,
                  providerId,
                  placementId: firstPlacement(providerId, providers),
                  machineId: "",
                  machineName: "",
                }))
              }
              options={providerOptions}
              value={draft.providerId}
            />
          </label>
          {draftProvider === undefined ? null : (
            <p className="project-provider-policy__hint" role="status">
              {providerCapability(draftProvider)}
              {draftProvider.needsSetup === undefined
                ? ""
                : ` ${setupMessage(draftProvider.needsSetup, draftProvider.displayName)}`}
            </p>
          )}
          {placementOptions.length === 0 ? null : (
            <label className="project-provider-policy__mode">
              <span>Runs on</span>
              <OctantSelectField
                aria-label="Where the desktop runs"
                disabled={disabled}
                onValueChange={(placementId) =>
                  setDraft((current) => ({
                    ...current,
                    placementId,
                    machineId: "",
                    machineName: "",
                  }))
                }
                options={placementOptions}
                value={draft.placementId}
              />
            </label>
          )}
          {choosesMachine ? (
            <>
              <label className="project-provider-policy__mode">
                <span>Computer</span>
                <OctantSelectField
                  aria-label="Which computer"
                  disabled={disabled}
                  onValueChange={(machineId) =>
                    setDraft((current) => ({
                      ...current,
                      machineId,
                      machineName:
                        listedMachines.find((machine) => String(machine.machineId) === machineId)
                          ?.displayName ?? machineId,
                    }))
                  }
                  options={machineOptions}
                  placeholder={
                    offeredMachines.status === "loading"
                      ? "Listing your computers…"
                      : "Choose a computer"
                  }
                  value={draft.machineId}
                />
              </label>
              {offeredMachines.status === "failed" ? (
                <p className="project-provider-policy__hint" role="status">
                  Octant couldn't list your computers just now. Check that{" "}
                  {draftProvider?.displayName ?? "the provider"} is running here, then open these
                  settings again.
                </p>
              ) : null}
            </>
          ) : null}
          <label className="project-provider-policy__mode">
            <span>Screen</span>
            <OctantSelectField
              aria-label="Desktop screen size"
              disabled={disabled}
              onValueChange={(screen) => setDraft((current) => ({ ...current, screen }))}
              options={screenOptions}
              value={draft.screen}
            />
          </label>
          {MINUTE_FIELDS.map((field) => (
            <label className="project-provider-policy__mode" key={field.key}>
              <span>{field.label}</span>
              <OctantSelectField
                aria-label={field.description}
                disabled={disabled}
                onValueChange={(value) =>
                  setDraft((current) => ({ ...current, [field.key]: Number(value) }))
                }
                options={minuteOptions(field.presets, draft[field.key])}
                value={String(draft[field.key])}
              />
            </label>
          ))}
          {takesKey ? (
            <>
              <label className="project-provider-policy__mode">
                <span>API key</span>
                <OctantInput
                  aria-label={`${providerName} API key`}
                  autoComplete="new-password"
                  disabled={disabled || keyStoreUnavailable}
                  onChange={(event) => setKeyTyped(event.currentTarget.value.trim() !== "")}
                  placeholder={
                    keyCarries && saved.credentialRef !== undefined
                      ? "Enter a new key to replace it"
                      : undefined
                  }
                  ref={keyInput}
                  spellCheck={false}
                  type="password"
                />
              </label>
              <p className="project-provider-policy__hint" role="status">
                {keyMessage}
              </p>
              {keyReleasing ? (
                <p className="project-provider-policy__hint" role="status">
                  A previous key stays in {hostCredentialStore(hostPlatform)} until the desktops
                  made with it are gone, then Octant deletes it.
                </p>
              ) : null}
            </>
          ) : null}
          {billed ? (
            <>
              <label className="project-provider-policy__mode">
                <span>Cost per hour</span>
                <OctantInput
                  aria-label="What an hour of this desktop costs you, in US dollars"
                  disabled={disabled}
                  inputMode="decimal"
                  onChange={(event) => {
                    const hourlyCost = event.currentTarget.value;
                    setDraft((current) => ({ ...current, hourlyCost }));
                  }}
                  placeholder="0.40"
                  value={draft.hourlyCost}
                />
              </label>
              <p className="project-provider-policy__hint">
                What an hour of this desktop costs on your account, in US dollars. Before each
                desktop starts, Octant estimates its most from this and checks it against your
                monthly cap in Settings › Computer use.
              </p>
            </>
          ) : null}
          {costRefusal === undefined ? null : <OctantFieldError>{costRefusal}</OctantFieldError>}
          {limitsRefusal === undefined ? null : (
            <OctantFieldError>{limitsRefusal}</OctantFieldError>
          )}
          <p className="project-provider-policy__hint">
            Network: none. A person can extend a running desktop up to its longest time; an agent
            cannot.
          </p>
        </>
      )}
      <div>
        {providers.length === 0 ? null : (
          <OctantButton
            disabled={!canSave}
            onClick={() => void commit(recipeOf(draft, saved, providers), takeTypedKey())}
            size="sm"
            type="button"
          >
            {saved === undefined ? "Set recipe" : "Save recipe"}
          </OctantButton>
        )}
        {takesKey && keyCarries && saved.credentialRef !== undefined ? (
          <OctantButton
            disabled={disabled}
            onClick={() => setConfirmKeyRemoval(true)}
            size="sm"
            type="button"
            variant="ghost"
          >
            Remove key
          </OctantButton>
        ) : null}
        {saved === undefined ? null : (
          <OctantButton
            disabled={disabled}
            onClick={() => setConfirmRemove(true)}
            size="sm"
            type="button"
            variant="ghost"
          >
            Remove recipe
          </OctantButton>
        )}
      </div>
      {confirmRemove ? (
        <OctantConfirmDialog
          confirmLabel="Remove recipe"
          destructive
          onCancel={() => setConfirmRemove(false)}
          onConfirm={() => {
            setConfirmRemove(false);
            void commit(null);
          }}
          title="Remove the desktop recipe?"
        >
          This Project's threads can't start a desktop until a recipe is set again, and any desktop
          running from it now is destroyed.
        </OctantConfirmDialog>
      ) : null}
      {confirmKeyRemoval && saved !== undefined ? (
        <OctantConfirmDialog
          confirmLabel="Remove key"
          destructive
          onCancel={() => setConfirmKeyRemoval(false)}
          onConfirm={() => {
            setConfirmKeyRemoval(false);
            void commit(saved, { action: "remove" });
          }}
          title="Remove the desktop key?"
        >
          The recipe stays, but this Project's threads can't start a desktop until a key is entered
          again. Any desktop running from it now is destroyed, and the key is deleted from{" "}
          {hostCredentialStore(hostPlatform)} once that desktop is gone.
        </OctantConfirmDialog>
      ) : null}
    </section>
  );
}
