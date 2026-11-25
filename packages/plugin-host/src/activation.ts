import type {
  ExtensionActivationState,
  ExtensionComponent,
  ExtensionEffectiveState,
  ExtensionImageGenerationModel,
  ExtensionMediaGenerationDeclaration,
  ExtensionPackageState,
  ExtensionSource,
  ExtensionVideoGenerationModel,
} from "@octant/contracts/extensions";
import type { OctantMode } from "@octant/contracts/modes";

const rendererKinds = [
  "ui-surface",
  "appearance-pack",
  "preview-viewer",
  "theme",
  "ground",
] as const;
const providerDriverKind = ["provider-driver"] as const;
// Chat never leases a desktop: a Chat Project has no root to send an artifact from.
const desktopProviderKind = ["desktop-provider"] as const;

const modeKinds: Readonly<Record<OctantMode, ReadonlySet<ExtensionComponent["kind"]>>> = {
  chat: new Set([
    "skill-instructions",
    "mcp-server",
    "mcp-tool",
    "mcp-prompt",
    "mcp-resource",
    "canvas-export-target",
    ...rendererKinds,
    ...providerDriverKind,
  ]),
  work: new Set([
    "skill-instructions",
    "mcp-server",
    "mcp-tool",
    "mcp-prompt",
    "mcp-resource",
    "app",
    "canvas-export-target",
    ...rendererKinds,
    ...providerDriverKind,
    ...desktopProviderKind,
  ]),
  code: new Set([
    "code-tool",
    "skill-instructions",
    "mcp-server",
    "mcp-tool",
    "mcp-prompt",
    "mcp-resource",
    "hook",
    "app",
    "agent",
    "apple-development-adapter",
    "board",
    "integration",
    // Code only: Work has no developer environment and Chat has no folder.
    "language-server",
    "debug-adapter",
    "pull-request-reviewer",
    "canvas-export-target",
    ...rendererKinds,
    ...providerDriverKind,
    ...desktopProviderKind,
  ]),
};

const modeProhibitedCapabilities: Readonly<
  Record<OctantMode, ReadonlySet<ExtensionComponent["declaredCapabilities"][number]>>
> = {
  chat: new Set([
    "filesystem",
    "shell",
    "credentials",
    "external-application",
    "hooks",
    "apps",
    "agents",
    "apple-development",
  ]),
  work: new Set(["shell", "hooks", "agents", "apple-development"]),
  code: new Set(),
};

export function isExtensionComponentModeSafe(
  mode: OctantMode,
  component: ExtensionComponent,
): boolean {
  return (
    modeKinds[mode].has(component.kind) &&
    component.declaredCapabilities.every(
      (capability) => !modeProhibitedCapabilities[mode].has(capability),
    )
  );
}

/**
 * Whether a host may ever run a stored component's process. Only macOS
 * confines one (deny-default Seatbelt with no network, exec, or fork). A
 * stored provider-driver component is an outside driver, which Linux also
 * runs, unconfined and labelled ({@link outsideDriverHostLaunch}). Any other
 * component with a process, and every component on Windows, is
 * `host-prohibited` rather than started unconfined.
 */
export function isExtensionComponentHostAdmitted(
  platform: string,
  component: ExtensionComponent,
): boolean {
  // A cloud machine target calls a cloud provider on the person's account, and
  // no launch class yet confines a process that needs that network reach, so
  // no platform runs one from a stored package. Pull request reviewer plugins
  // likewise have no out-of-process confined worker launch class yet.
  if (component.kind === "cloud-machine-target" || component.kind === "pull-request-reviewer") {
    return false;
  }
  if (component.kind === "provider-driver") {
    return outsideDriverHostLaunch(platform) !== "prohibited";
  }
  return component.kind !== "canvas-export-target" || isOutsideDriverHostConfined(platform);
}

/** Whether this platform confines an outside provider driver's process. */
export function isOutsideDriverHostConfined(platform: string): boolean {
  return platform === "darwin";
}

/**
 * How this platform runs an outside provider driver's process. macOS confines
 * it under the driver profile. Linux has no extension-process confinement, and
 * a driver the person installed, trusted and enabled runs there without one,
 * which its provider row says (maintainer decision, 2026-11-16). Windows runs
 * none.
 */
export type OutsideDriverHostLaunch = "confined" | "unconfined" | "prohibited";

export function outsideDriverHostLaunch(platform: string): OutsideDriverHostLaunch {
  if (isOutsideDriverHostConfined(platform)) return "confined";
  return platform === "linux" ? "unconfined" : "prohibited";
}

export interface ExtensionActivationContext extends ExtensionActivationState {
  readonly hostAllowed: boolean;
  readonly modeAllowed: boolean;
  readonly projectAllowed: boolean;
  readonly threadAllowed: boolean;
  readonly catalogCurrent: boolean;
}

export function resolveExtensionActivation(
  state: ExtensionActivationContext,
): ExtensionEffectiveState {
  if (!state.hostAllowed) return { kind: "blocked", reason: "host-prohibited" };
  if (!state.modeAllowed) return { kind: "blocked", reason: "mode-prohibited" };
  if (!state.projectAllowed || !state.policyAllowed) {
    return { kind: "blocked", reason: "project-prohibited" };
  }
  if (!state.threadAllowed) return { kind: "blocked", reason: "thread-prohibited" };
  if (!state.catalogCurrent) return { kind: "blocked", reason: "stale-catalog-epoch" };
  if (!state.installed) return { kind: "blocked", reason: "not-installed" };
  if (state.quarantined) return { kind: "blocked", reason: "quarantined" };
  if (!state.trusted) return { kind: "blocked", reason: "untrusted" };
  if (!state.pluginDesired) return { kind: "blocked", reason: "plugin-disabled" };
  if (!state.componentDesired) return { kind: "blocked", reason: "component-disabled" };
  if (!state.compatible) return { kind: "blocked", reason: "incompatible" };
  if (state.draining) return { kind: "blocked", reason: "draining" };
  if (state.broken) return { kind: "blocked", reason: "broken" };
  if (state.unavailable) return { kind: "blocked", reason: "unavailable" };
  if (state.interrupted) return { kind: "blocked", reason: "interrupted" };
  if (state.waiting) return { kind: "blocked", reason: "waiting" };
  return { kind: "effective" };
}

/** The exact package an outside driver instance binds, as the activation ladder reads it. */
export interface OutsideDriverActivationTarget {
  readonly extensionId: string;
  readonly packageId: string;
  readonly componentId: string;
  readonly version: string;
  readonly digest: string;
}

/**
 * Whether the outside driver one provider instance binds is effective on this
 * host. It is the ladder every component climbs, at host scope: a provider
 * instance serves every mode and belongs to no Project or thread, so the
 * driver must be safe in all three modes. Beyond the ladder, the package must
 * still select the exact version and digest the instance was added with; any
 * other selection is `superseded`, so trust and Verify tools records never
 * carry over to code the person did not add the provider from.
 *
 * Running a driver without confinement on Linux is a lift Octant made; under
 * the host's Strict the driver is `host-prohibited` there, as before it.
 */
export function resolveOutsideDriverActivation(input: {
  readonly platform: string;
  readonly packageState: ExtensionPackageState | undefined;
  /** The host's own verdict on the package's app range and platforms. */
  readonly compatible: boolean;
  readonly driver: OutsideDriverActivationTarget;
  /** The host's Strict: a driver this host would run unconfined is refused. */
  readonly strict?: boolean;
}): ExtensionEffectiveState {
  const launch = outsideDriverHostLaunch(input.platform);
  if (launch === "prohibited" || (launch === "unconfined" && input.strict === true)) {
    return { kind: "blocked", reason: "host-prohibited" };
  }
  const packageState = input.packageState;
  const componentState = packageState?.components.find(
    (candidate) => String(candidate.component.id) === input.driver.componentId,
  );
  if (
    packageState === undefined ||
    String(packageState.extensionId) !== input.driver.extensionId ||
    String(packageState.packageId) !== input.driver.packageId ||
    componentState === undefined ||
    componentState.component.kind !== "provider-driver" ||
    !componentState.activation.installed
  ) {
    return { kind: "blocked", reason: "not-installed" };
  }
  if (
    String(packageState.version) !== input.driver.version ||
    String(packageState.digest) !== input.driver.digest
  ) {
    return { kind: "blocked", reason: "superseded" };
  }
  const component = componentState.component;
  return resolveExtensionActivation({
    ...componentState.activation,
    compatible: input.compatible && componentState.activation.compatible,
    hostAllowed: true,
    modeAllowed: (["chat", "work", "code"] as const).every((mode) =>
      isExtensionComponentModeSafe(mode, component),
    ),
    projectAllowed: true,
    threadAllowed: true,
    catalogCurrent: true,
  });
}

/**
 * What an outside media driver declares, read from the package at exactly the
 * version and digest a profile binds. Anything else (another digest, a harness
 * endpoint, a missing component) declares nothing, so a price never comes from
 * code the person did not add the profile from.
 */
function outsideMediaDeclaration(input: {
  readonly packageState: ExtensionPackageState | undefined;
  readonly driver: OutsideDriverActivationTarget;
}): ExtensionMediaGenerationDeclaration | undefined {
  const { packageState, driver } = input;
  if (
    packageState === undefined ||
    String(packageState.extensionId) !== driver.extensionId ||
    String(packageState.packageId) !== driver.packageId ||
    String(packageState.version) !== driver.version ||
    String(packageState.digest) !== driver.digest
  ) {
    return undefined;
  }
  const component = packageState.components.find(
    (candidate) => String(candidate.component.id) === driver.componentId,
  )?.component;
  return component?.kind === "provider-driver" ? component.mediaGeneration : undefined;
}

/** The image models and prices an outside image driver declares, or nothing. */
export function outsideImageDriverModels(
  input: Parameters<typeof outsideMediaDeclaration>[0],
): ReadonlyArray<ExtensionImageGenerationModel> | undefined {
  const declaration = outsideMediaDeclaration(input);
  return declaration?.media === "image" ? declaration.models : undefined;
}

/** The video models, prices and job facts an outside video driver declares, or nothing. */
export function outsideVideoDriverModels(
  input: Parameters<typeof outsideMediaDeclaration>[0],
): ReadonlyArray<ExtensionVideoGenerationModel> | undefined {
  const declaration = outsideMediaDeclaration(input);
  return declaration?.media === "video" ? declaration.models : undefined;
}

/**
 * Whether an image profile's outside driver is effective: the same ladder a
 * harness endpoint climbs, and the bound component must still declare image
 * generation. A driver that declares none is `incompatible`, so a chat
 * driver can never be reached through the image tools.
 */
export function resolveOutsideImageDriverActivation(
  input: Parameters<typeof resolveOutsideDriverActivation>[0],
): ExtensionEffectiveState {
  const state = resolveOutsideDriverActivation(input);
  if (state.kind !== "effective") return state;
  return outsideImageDriverModels(input) === undefined
    ? { kind: "blocked", reason: "incompatible" }
    : state;
}

/** The same for a video profile: its bound component must still declare video generation. */
export function resolveOutsideVideoDriverActivation(
  input: Parameters<typeof resolveOutsideDriverActivation>[0],
): ExtensionEffectiveState {
  const state = resolveOutsideDriverActivation(input);
  if (state.kind !== "effective") return state;
  return outsideVideoDriverModels(input) === undefined
    ? { kind: "blocked", reason: "incompatible" }
    : state;
}

/**
 * The same for a harness endpoint: a package that generates media speaks no
 * harness endpoint protocol, so it can never run as one.
 */
export function resolveOutsideHarnessEndpointActivation(
  input: Parameters<typeof resolveOutsideDriverActivation>[0],
): ExtensionEffectiveState {
  const state = resolveOutsideDriverActivation(input);
  return state.kind === "effective" && outsideMediaDeclaration(input) !== undefined
    ? { kind: "blocked", reason: "incompatible" }
    : state;
}

/** One outside image driver a person can add an image profile from. */
export interface OutsideImageDriverChoice {
  readonly driver: OutsideDriverActivationTarget;
  readonly displayName: string;
  readonly source: ExtensionSource;
  readonly models: ReadonlyArray<ExtensionImageGenerationModel>;
}

/**
 * The outside image drivers this host admits: installed, trusted, enabled,
 * compatible, and able to run here. Discovery grants nothing; a profile added
 * from a choice is checked against the ladder again at every use.
 */
export function listOutsideImageDriverChoices(input: {
  readonly platform: string;
  readonly packages: ReadonlyArray<ExtensionPackageState>;
  readonly compatible: (packageState: ExtensionPackageState) => boolean;
  readonly strict?: boolean;
}): ReadonlyArray<OutsideImageDriverChoice> {
  return input.packages.flatMap((packageState) =>
    packageState.components.flatMap(({ component }) => {
      if (component.kind !== "provider-driver") return [];
      const driver: OutsideDriverActivationTarget = {
        extensionId: String(packageState.extensionId),
        packageId: String(packageState.packageId),
        componentId: String(component.id),
        version: String(packageState.version),
        digest: String(packageState.digest),
      };
      const state = resolveOutsideImageDriverActivation({
        platform: input.platform,
        packageState,
        compatible: input.compatible(packageState),
        driver,
        ...(input.strict === undefined ? {} : { strict: input.strict }),
      });
      const models = outsideImageDriverModels({ packageState, driver });
      if (state.kind !== "effective" || models === undefined) return [];
      return [
        {
          driver,
          displayName: packageState.displayName ?? packageState.slug ?? component.displayName,
          source: packageState.source,
          models,
        },
      ];
    }),
  );
}

/**
 * The selection an outside driver instance moves to once its person has
 * trusted it: the package's current version and digest, when the source is
 * trusted at that selection and nothing holds it, the package and component
 * are the ones the instance was added from, and the instance binds another
 * digest. Anything else leaves the binding where it is.
 *
 * Trust is the only thing that can satisfy this: every install, update, and
 * rollback clears it and holds the package for admission, so an update never
 * moves an instance by itself. The switches are not consulted, since trusting
 * is the review step and the switches only decide whether the bound digest
 * runs; an instance moved while the plugin is off reports the block until it
 * is switched on.
 */
export function resolveOutsideDriverRebind(input: {
  readonly packageState: ExtensionPackageState | undefined;
  readonly driver: OutsideDriverActivationTarget;
}): OutsideDriverActivationTarget | undefined {
  const { packageState, driver } = input;
  if (
    packageState === undefined ||
    String(packageState.extensionId) !== driver.extensionId ||
    String(packageState.packageId) !== driver.packageId
  ) {
    return undefined;
  }
  const componentState = packageState.components.find(
    (candidate) => String(candidate.component.id) === driver.componentId,
  );
  if (
    componentState === undefined ||
    componentState.component.kind !== "provider-driver" ||
    !componentState.activation.installed ||
    !componentState.activation.trusted ||
    componentState.activation.quarantined
  ) {
    return undefined;
  }
  const version = String(packageState.version);
  const digest = String(packageState.digest);
  if (version === driver.version && digest === driver.digest) return undefined;
  return { ...driver, version, digest };
}
