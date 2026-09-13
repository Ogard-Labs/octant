import type { ProjectProviderPolicy, ProjectSummary } from "@octant/contracts/projects";
import type { ProviderInstance } from "@octant/contracts/providers";
import { isProviderAllowedByProjectPolicy, type PickerGroup } from "@octant/domain";
import { useMemo } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantCheckbox } from "../ui/base/OctantCheckbox";
import { OctantSelectField } from "../ui/base/OctantSelect";

type BoundProjectSummary = Extract<ProjectSummary, { readonly type: "work" | "code" }>;

export interface ProjectProviderPolicySectionProps {
  readonly project: BoundProjectSummary;
  readonly providerInstances: ReadonlyArray<ProviderInstance>;
  readonly onChange: (policy: ProjectProviderPolicy) => Promise<boolean>;
  readonly disabled?: boolean;
}

const DEFAULT_POLICY: ProjectProviderPolicy = {
  mode: "all",
  providerInstanceIds: [],
};

/** Keep project composers from offering choices the server will refuse. */
export function providerGroupsForProject(
  project: BoundProjectSummary,
  groups: ReadonlyArray<PickerGroup>,
): ReadonlyArray<PickerGroup> {
  const policy = project.providerPolicy ?? DEFAULT_POLICY;
  if (policy.mode === "all") return groups;
  return groups
    .filter((group) =>
      policy.mode === "whitelist"
        ? policy.providerInstanceIds.some((id) => String(id) === String(group.instance.id))
        : true,
    )
    .map((group) => {
      if (policy.mode !== "eu-zdr") return group;
      const sections = group.sections
        .map((section) => ({
          ...section,
          models: section.models.filter((model) =>
            isProviderAllowedByProjectPolicy(project, group.instance, model.model),
          ),
        }))
        .filter((section) => section.models.length > 0);
      return { ...group, sections };
    })
    .filter((group) => group.sections.some((section) => section.models.length > 0));
}

export function ProjectProviderPolicySection(props: ProjectProviderPolicySectionProps) {
  const policy = props.project.providerPolicy ?? DEFAULT_POLICY;
  const selected = useMemo(
    () => new Set(policy.providerInstanceIds.map((id) => String(id))),
    [policy.providerInstanceIds],
  );

  async function changeMode(mode: ProjectProviderPolicy["mode"]) {
    if (mode === policy.mode) return;
    await props.onChange({
      mode,
      providerInstanceIds: mode === "whitelist" ? policy.providerInstanceIds : [],
    });
  }

  async function toggleProvider(provider: ProviderInstance) {
    const next = new Set(selected);
    if (next.has(String(provider.id))) next.delete(String(provider.id));
    else next.add(String(provider.id));
    const providerInstanceIds = props.providerInstances
      .filter((candidate) => next.has(String(candidate.id)))
      .map((candidate) => candidate.id);
    await props.onChange({ mode: "whitelist", providerInstanceIds });
  }

  return (
    <section
      className="project-provider-policy"
      aria-labelledby={`provider-policy-${props.project.id}`}
    >
      <div className="project-provider-policy__header">
        <div>
          <h2 id={`provider-policy-${props.project.id}`}>Provider access</h2>
          <p>
            Choose which providers and models this {props.project.type} Project may use. New and
            existing turns are checked by the host.
          </p>
        </div>
        <span className="project-provider-policy__default">Default: allow all</span>
      </div>
      <label className="project-provider-policy__mode">
        <span>Policy</span>
        <OctantSelectField
          aria-label="Project provider policy"
          disabled={props.disabled === true}
          onValueChange={(value) => {
            if (value === "all" || value === "eu-zdr" || value === "whitelist") {
              void changeMode(value);
            }
          }}
          options={[
            { id: "all", label: "Allow all providers" },
            { id: "eu-zdr", label: "Allow EU or ZDR tagged providers/models" },
            { id: "whitelist", label: "Allow only selected providers" },
          ]}
          value={policy.mode}
        />
      </label>
      {policy.mode === "whitelist" ? (
        <div className="project-provider-policy__providers" aria-label="Allowed providers">
          {props.providerInstances.length === 0 ? (
            <p className="project-provider-policy__empty">No providers are configured yet.</p>
          ) : (
            props.providerInstances.map((provider) => (
              <label className="project-provider-policy__provider" key={String(provider.id)}>
                <OctantCheckbox
                  checked={selected.has(String(provider.id))}
                  disabled={props.disabled === true}
                  onChange={() => void toggleProvider(provider)}
                />
                <span>{provider.displayName}</span>
                <small>{provider.driverKind}</small>
              </label>
            ))
          )}
        </div>
      ) : null}
      {policy.mode === "eu-zdr" ? (
        <p className="project-provider-policy__hint">
          Tag providers or individual models as EU or ZDR in Settings → Providers &amp; Models.
          Untagged choices are refused when this policy is active.
        </p>
      ) : null}
      {policy.mode === "whitelist" && selected.size === 0 ? (
        <p className="project-provider-policy__hint">
          Select at least one provider to start turns.
        </p>
      ) : null}
      <OctantButton
        disabled={props.disabled === true}
        size="sm"
        type="button"
        variant="ghost"
        onClick={() => void props.onChange(DEFAULT_POLICY)}
      >
        Reset to allow all
      </OctantButton>
    </section>
  );
}
