import type { ProjectProviderPolicy, ProjectSummary } from "@octant/contracts/projects";
import type { ProviderInstance, ProviderModel } from "@octant/contracts/providers";
import type { PickerGroup } from "@octant/domain";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  ProjectProviderPolicySection,
  providerGroupsForProject,
} from "./ProjectProviderPolicySection";

const provider = (id: string, dataTags?: ProviderInstance["dataTags"]): ProviderInstance =>
  ({
    id,
    displayName: "Gateway",
    driverKind: "openai-compatible",
    configuration: {
      kind: "openai-compatible-http",
      baseUrl: "https://gateway.example/v1",
      authentication: "bearer",
      protocol: "auto",
      manualModelIds: ["model"],
    },
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1,
    createdAt: "2026-07-14T10:00:00.000Z",
    updatedAt: "2026-07-14T10:00:00.000Z",
    ...(dataTags === undefined ? {} : { dataTags }),
  }) as unknown as ProviderInstance;

const model = (id: string, dataTags?: ProviderModel["dataTags"]): ProviderModel =>
  ({
    id,
    displayName: "Model",
    source: "manual",
    verification: "unverified",
    reasoning: "supported",
    inputModalities: ["text"],
    options: [],
    ...(dataTags === undefined ? {} : { dataTags }),
  }) as unknown as ProviderModel;

const project = (
  providerPolicy?: ProjectProviderPolicy,
): Extract<ProjectSummary, { type: "code" }> =>
  ({
    id: "80000000-0000-4000-8000-000000000001",
    type: "code",
    name: "Code",
    lifecycle: "active",
    pinned: false,
    rank: "0/1",
    version: 1,
    createdAt: "2026-07-14T10:00:00.000Z",
    updatedAt: "2026-07-14T10:00:00.000Z",
    binding: { canonicalRoot: "/tmp/code" },
    bindingRevisionId: "80000000-0000-4000-8000-000000000002",
    codeAccessPersistence: "current-session",
    ...(providerPolicy === undefined ? {} : { providerPolicy }),
  }) as unknown as Extract<ProjectSummary, { type: "code" }>;

const group = (instance: ProviderInstance, candidate: ProviderModel): PickerGroup =>
  ({
    instance,
    runtime: "provider",
    readiness: "ready",
    driverLabel: "Gateway",
    endpointHost: "gateway.example",
    executionHost: "host",
    sections: [
      {
        id: "all-models",
        label: "All models",
        models: [{ model: candidate, badges: [], toolCapable: true }],
      },
    ],
  }) as PickerGroup;

describe("ProjectProviderPolicySection", () => {
  it("filters EU/ZDR model choices while retaining tagged providers", () => {
    const untagged = provider("80000000-0000-4000-8000-000000000010");
    const tagged = provider("80000000-0000-4000-8000-000000000011");
    const groups = providerGroupsForProject(project({ mode: "eu-zdr", providerInstanceIds: [] }), [
      group(untagged, model("untagged")),
      group(tagged, model("tagged", ["zdr"])),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.instance.id).toBe(tagged.id);
    expect(groups[0]?.sections[0]?.models[0]?.model.id).toBe("tagged");
  });

  it("lets a Project choose whitelist mode and selected providers", async () => {
    const user = userEvent.setup();
    const first = provider("80000000-0000-4000-8000-000000000010");
    const second = { ...provider("80000000-0000-4000-8000-000000000011"), displayName: "Second" };
    const onChange = vi.fn(async () => true);
    const view = render(
      <ProjectProviderPolicySection
        onChange={onChange}
        project={project()}
        providerInstances={[first, second]}
      />,
    );

    await user.click(screen.getByRole("combobox", { name: "Project provider policy" }));
    await user.click(await screen.findByRole("option", { name: "Allow only selected providers" }));
    view.rerender(
      <ProjectProviderPolicySection
        onChange={onChange}
        project={project({ mode: "whitelist", providerInstanceIds: [] })}
        providerInstances={[first, second]}
      />,
    );
    const section = screen.getByRole("region", { name: "Provider access" });
    await user.click(within(section).getByRole("checkbox", { name: /^Gateway/ }));

    expect(onChange).toHaveBeenNthCalledWith(1, { mode: "whitelist", providerInstanceIds: [] });
    expect(onChange).toHaveBeenNthCalledWith(2, {
      mode: "whitelist",
      providerInstanceIds: [first.id],
    });
  });
});
