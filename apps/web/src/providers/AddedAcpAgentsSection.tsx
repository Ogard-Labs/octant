import type { AddedAcpAgentProviderInstance, ProviderInstance } from "@octant/contracts";
import { ACP_REGISTRY_AGENTS, acpRegistryAgent } from "@octant/plugin-host/acp-agents";
import { useId, useState } from "react";
import { SettingsSection } from "../settings/primitives";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantBadge } from "../ui/base/OctantBadge";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantSelectField } from "../ui/base/OctantSelect";
import type { AcpAgentStep } from "./useProviderController";

export interface AddedAcpAgentsSectionProps {
  readonly instances: ReadonlyArray<ProviderInstance>;
  readonly busy: boolean;
  readonly onStep: (step: AcpAgentStep) => Promise<boolean>;
}

function isAddedAgent(instance: ProviderInstance): instance is AddedAcpAgentProviderInstance {
  return instance.driverKind === "acp-agent";
}

/** What the install step can say about the bytes it put on disk, in the person's words. */
function integritySentence(agent: AddedAcpAgentProviderInstance): string | undefined {
  const install = agent.configuration.install;
  const source = agent.configuration.source;
  if (install === undefined) return undefined;
  switch (install.integrity) {
    case "unverified-download":
      return "Unverified download: the ACP registry lists no checksum for this release, so only HTTPS vouched for the bytes Octant installed.";
    case "sha256-verified":
      return "The download matched the checksum the ACP registry lists for this release.";
    case "package-manager":
      return source.kind === "registry"
        ? `The package manager installed exactly release ${source.version}, checked against its registry's own integrity data, with install scripts off.`
        : undefined;
    case "local-command":
      return `Your own command at ${install.executable}. Octant did not fetch it.`;
  }
}

/** Splits typed arguments on whitespace. Nothing is passed to a shell, so nothing is unquoted. */
function argumentsOf(text: string): ReadonlyArray<string> {
  return text.split(/\s+/u).filter((part) => part.length > 0);
}

/**
 * Settings' flow for any ACP agent (Provider runtimes: "Any ACP agent"):
 * add one from the ACP registry or as your own command, then install it,
 * trust it and turn it on, each its own step the host decides. Nothing here
 * grants anything: the host refuses a step out of order.
 */
export function AddedAcpAgentsSection(props: AddedAcpAgentsSectionProps) {
  const agents = props.instances.filter(isAddedAgent);
  const [adding, setAdding] = useState(false);
  return (
    <SettingsSection
      title="Any ACP agent"
      description="Add an agent from the public ACP registry, or your own local command. Octant has reviewed none of these: each is installed, trusted and turned on in its own step, and until you trust it, it runs in Octant's sandbox and nothing about it is remembered."
      actions={
        adding ? null : (
          <OctantButton
            className="window-no-drag"
            disabled={props.busy}
            onClick={() => setAdding(true)}
            size="sm"
            type="button"
            variant="secondary"
          >
            Add ACP agent
          </OctantButton>
        )
      }
    >
      {adding ? (
        <AddAcpAgentForm
          busy={props.busy}
          onCancel={() => setAdding(false)}
          onAdd={async (source) => {
            if (await props.onStep({ kind: "add", source })) setAdding(false);
          }}
        />
      ) : null}
      {agents.length === 0 && !adding ? (
        <p className="provider-settings__hint">No agent added yet.</p>
      ) : null}
      <ul className="added-acp-agents" aria-label="Added ACP agents">
        {agents.map((agent) => (
          <AddedAcpAgentRow agent={agent} busy={props.busy} key={agent.id} onStep={props.onStep} />
        ))}
      </ul>
    </SettingsSection>
  );
}

function AddAcpAgentForm(props: {
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onAdd: (source: Extract<AcpAgentStep, { kind: "add" }>["source"]) => Promise<void>;
}) {
  const id = useId();
  const [from, setFrom] = useState<"registry" | "local">("registry");
  const [registryId, setRegistryId] = useState(ACP_REGISTRY_AGENTS[0]?.registryId ?? "");
  const [displayName, setDisplayName] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const listed = acpRegistryAgent(registryId);
  const localReady = displayName.trim().length > 0 && command.trim().startsWith("/");
  return (
    <form
      aria-label="Add ACP agent"
      noValidate
      className="added-acp-agents__form"
      onSubmit={(event) => {
        event.preventDefault();
        void props.onAdd(
          from === "registry"
            ? { kind: "registry", registryId }
            : {
                kind: "local",
                displayName: displayName.trim(),
                command: command.trim(),
                args: argumentsOf(args),
              },
        );
      }}
    >
      <div className="setgroup">
        <div className="setrow">
          <span className="setrow-label">Source</span>
          <div className="setrow-control">
            <OctantSelectField
              aria-label="Source"
              onValueChange={(value) => setFrom(value === "local" ? "local" : "registry")}
              options={[
                { id: "registry", label: "From the ACP registry" },
                { id: "local", label: "My own command" },
              ]}
              value={from}
            />
          </div>
        </div>
        {from === "registry" ? (
          <div className="setrow">
            <span className="setrow-label">Agent</span>
            <p className="setrow-hint">
              {listed === undefined
                ? null
                : `Release ${listed.version}, ${
                    listed.distribution.kind === "binary"
                      ? "downloaded from the address the registry lists"
                      : `installed with ${listed.distribution.kind === "npx" ? "npm" : "uv"}`
                  }. Octant has no reviewed profile for it yet. ${listed.unreviewedBecause}`}
            </p>
            <div className="setrow-control">
              <OctantSelectField
                aria-label="Registry agent"
                onValueChange={setRegistryId}
                options={ACP_REGISTRY_AGENTS.map((agent) => ({
                  id: agent.registryId,
                  label: agent.name,
                }))}
                value={registryId}
              />
            </div>
          </div>
        ) : (
          <>
            <div className="setrow">
              <label className="setrow-label" htmlFor={`${id}-name`}>
                Name
              </label>
              <div className="setrow-control">
                <OctantInput
                  id={`${id}-name`}
                  onChange={(event) => setDisplayName(event.target.value)}
                  value={displayName}
                />
              </div>
            </div>
            <div className="setrow">
              <label className="setrow-label" htmlFor={`${id}-command`}>
                Command
              </label>
              <p className="setrow-hint">The absolute path to the agent's executable.</p>
              <div className="setrow-control">
                <OctantInput
                  id={`${id}-command`}
                  onChange={(event) => setCommand(event.target.value)}
                  placeholder="/usr/local/bin/my-agent"
                  value={command}
                />
              </div>
            </div>
            <div className="setrow">
              <label className="setrow-label" htmlFor={`${id}-args`}>
                Arguments
              </label>
              <p className="setrow-hint">
                Separated by spaces and passed as typed, never through a shell. Octant records them,
                so leave keys out: sign the agent in with its own command.
              </p>
              <div className="setrow-control">
                <OctantInput
                  id={`${id}-args`}
                  onChange={(event) => setArgs(event.target.value)}
                  placeholder="acp"
                  value={args}
                />
              </div>
            </div>
          </>
        )}
      </div>
      <div className="added-acp-agents__actions">
        <OctantButton
          disabled={props.busy || (from === "local" ? !localReady : listed === undefined)}
          size="sm"
          type="submit"
        >
          Add
        </OctantButton>
        <OctantButton onClick={props.onCancel} size="sm" type="button" variant="ghost">
          Cancel
        </OctantButton>
      </div>
    </form>
  );
}

function AddedAcpAgentRow(props: {
  readonly agent: AddedAcpAgentProviderInstance;
  readonly busy: boolean;
  readonly onStep: (step: AcpAgentStep) => Promise<boolean>;
}) {
  const { agent } = props;
  const installed = agent.configuration.install !== undefined;
  const trusted = agent.configuration.trusted;
  const step = (kind: Extract<AcpAgentStep, { instanceId: unknown }>["kind"]) =>
    void props.onStep({ kind, instanceId: agent.id });
  const integrity = integritySentence(agent);
  const unverified = agent.configuration.install?.integrity === "unverified-download";
  const state = !installed
    ? "Added, not installed"
    : !trusted
      ? agent.enabled
        ? "On, not trusted: runs in Octant's sandbox"
        : "Installed, not trusted"
      : agent.enabled
        ? "Trusted and on"
        : "Trusted, off";
  return (
    <li className="added-acp-agents__agent" aria-label={agent.displayName}>
      <div className="added-acp-agents__heading">
        <strong>{agent.displayName}</strong>
        <OctantBadge>{state}</OctantBadge>
      </div>
      {installed && !trusted ? (
        <div className="added-acp-agents__trust" role="group" aria-label="Trust step">
          <p>
            Trusting {agent.displayName} lets it run as a reviewed agent does: outside Strict and
            below Full access Octant's protections follow its own settings, your approvals for it
            can be remembered, and Octant's tools are offered to it. Until you trust it, it runs in
            Octant's sandbox at every level, even Full access, every approval covers one call, and
            it gets none of Octant's tools.
          </p>
          {integrity === undefined ? null : (
            <OctantAlert tone={unverified ? "warning" : "neutral"}>{integrity}</OctantAlert>
          )}
        </div>
      ) : integrity === undefined ? null : (
        <p className="setrow-hint">{integrity}</p>
      )}
      <div className="added-acp-agents__actions">
        {!installed ? (
          <OctantButton disabled={props.busy} onClick={() => step("install")} size="sm">
            Install
          </OctantButton>
        ) : null}
        {installed && !trusted ? (
          <OctantButton disabled={props.busy} onClick={() => step("trust")} size="sm">
            Trust
          </OctantButton>
        ) : null}
        {installed && trusted && !agent.enabled ? (
          <OctantButton disabled={props.busy} onClick={() => step("enable")} size="sm">
            Turn on
          </OctantButton>
        ) : null}
        {agent.enabled ? (
          <OctantButton
            disabled={props.busy}
            onClick={() => step("disable")}
            size="sm"
            variant="secondary"
          >
            Turn off
          </OctantButton>
        ) : null}
        {trusted ? (
          <OctantButton
            disabled={props.busy}
            onClick={() => step("untrust")}
            size="sm"
            variant="secondary"
          >
            Stop trusting
          </OctantButton>
        ) : null}
        {installed && agent.configuration.source.kind === "registry" ? (
          <OctantButton
            disabled={props.busy}
            onClick={() => step("install")}
            size="sm"
            variant="ghost"
          >
            Reinstall
          </OctantButton>
        ) : null}
        <OctantButton
          disabled={props.busy}
          onClick={() => step("remove")}
          size="sm"
          variant="ghost"
        >
          Remove
        </OctantButton>
      </div>
    </li>
  );
}
