import type {
  ProjectProviderPolicy,
  ProviderDataTag,
  ProviderInstance,
  ProviderModel,
} from "@octant/contracts";

export class ProjectProviderPolicyRejected extends Error {
  override readonly name = "ProjectProviderPolicyRejected";

  constructor(
    readonly reason: "provider-not-allowed" | "model-not-allowed",
    message: string,
  ) {
    super(message);
  }
}

const acceptedTags: ReadonlySet<ProviderDataTag> = new Set(["eu", "zdr"]);

type ProjectProviderPolicyOwner = Readonly<{
  readonly providerPolicy?: ProjectProviderPolicy | undefined;
}>;

export function effectiveProjectProviderPolicy(
  project: ProjectProviderPolicyOwner,
): ProjectProviderPolicy {
  return project.providerPolicy ?? { mode: "all", providerInstanceIds: [] };
}

export function isProviderAllowedByProjectPolicy(
  project: ProjectProviderPolicyOwner,
  provider: ProviderInstance,
  model?: ProviderModel,
): boolean {
  const policy = effectiveProjectProviderPolicy(project);
  switch (policy.mode) {
    case "all":
      return true;
    case "whitelist":
      return policy.providerInstanceIds.some((id) => String(id) === String(provider.id));
    case "eu-zdr":
      return (
        hasAcceptedTag(provider.dataTags) || (model !== undefined && hasAcceptedTag(model.dataTags))
      );
  }
}

export function assertProviderAllowedByProjectPolicy(
  project: ProjectProviderPolicyOwner,
  provider: ProviderInstance,
  model?: ProviderModel,
): void {
  if (isProviderAllowedByProjectPolicy(project, provider, model)) return;
  if (effectiveProjectProviderPolicy(project).mode === "whitelist") {
    throw new ProjectProviderPolicyRejected(
      "provider-not-allowed",
      `Provider "${provider.displayName}" is not allowed by this Project's provider policy.`,
    );
  }
  throw new ProjectProviderPolicyRejected(
    "model-not-allowed",
    "This provider or model is not tagged EU or ZDR, so it is not allowed by this Project's provider policy.",
  );
}

function hasAcceptedTag(tags: ReadonlyArray<ProviderDataTag> | undefined): boolean {
  return tags?.some((tag) => acceptedTags.has(tag)) ?? false;
}
