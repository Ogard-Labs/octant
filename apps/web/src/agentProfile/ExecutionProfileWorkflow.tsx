import type { AgentProfile } from "@octant/contracts/agent-profile";
import type { OctantMode } from "@octant/contracts/modes";
import type { ProviderModelId } from "@octant/contracts/providers";
import { ChevronDown, Pencil, Plus, RotateCcw, Trash2, UserRoundCog } from "lucide-react";
import { useState, type FormEvent } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantDialog } from "../ui/base/OctantDialog";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantNativeSelect } from "../ui/base/OctantSelect";
import { OctantPopover } from "../ui/base/OctantPopover";
import { OctantTextarea } from "../ui/base/OctantTextarea";
import { ExecutionContextPicker } from "./ExecutionContextPicker";
import type {
  CreateExecutionProfileInput,
  ExecutionProfileController,
} from "./useExecutionProfileController";
import "./execution-profile.css";

export function ExecutionProfileWorkflow(props: {
  readonly controller: ExecutionProfileController;
  readonly variant: "composer" | "settings";
}) {
  const [open, setOpen] = useState(props.variant === "settings");
  const [editing, setEditing] = useState<AgentProfile | "create">();
  const [confirmDelete, setConfirmDelete] = useState<AgentProfile>();
  const controller = props.controller;
  const selectedName = controller.selectedProfile?.displayName ?? "No profile";

  const body = (
    <>
      {props.variant === "composer" ? (
        <div className="execution-profile-workflow__composer-actions">
          <p>Choose provider, model, profile, and host placement for this draft.</p>
          <OctantButton onClick={() => setEditing("create")} type="button" variant="ghost">
            <Plus aria-hidden="true" size={12} />
            Create profile
          </OctantButton>
        </div>
      ) : null}

      <ExecutionContextPicker
        disabled={controller.busy || controller.status === "loading"}
        entries={controller.entries}
        onSelect={controller.selectEntry}
        {...(controller.selectedEntry === undefined
          ? {}
          : { selectedEntry: controller.selectedEntry })}
      />

      {controller.message === undefined ? null : (
        <p className="execution-profile-workflow__alert" role="alert">
          {controller.message}
        </p>
      )}

      <ResolutionReceipt controller={controller} />

      <div className="execution-profile-workflow__profiles" aria-label="Saved profiles">
        {controller.profiles.length === 0 ? (
          <p className="execution-profile-workflow__empty">No saved profiles yet.</p>
        ) : (
          controller.profiles.map((profile) => (
            <article className="execution-profile-workflow__profile" key={String(profile.id)}>
              <OctantButton
                aria-pressed={String(controller.selectedProfile?.id) === String(profile.id)}
                className="execution-profile-workflow__profile-select"
                onClick={() => controller.selectProfile(profile.id)}
                type="button"
                variant="ghost"
              >
                <strong>{profile.displayName}</strong>
                <span>{profile.description ?? `${profile.defaultExecutionPolicy} defaults`}</span>
              </OctantButton>
              <span className="execution-profile-workflow__profile-actions">
                <OctantButton
                  aria-label={`Edit ${profile.displayName}`}
                  onClick={() => setEditing(profile)}
                  size="icon"
                  type="button"
                  variant="ghost"
                >
                  <Pencil aria-hidden="true" size={12} />
                </OctantButton>
                <OctantButton
                  aria-label={`Delete ${profile.displayName}`}
                  onClick={() => setConfirmDelete(profile)}
                  size="icon"
                  type="button"
                  variant="ghost"
                >
                  <Trash2 aria-hidden="true" size={12} />
                </OctantButton>
              </span>
            </article>
          ))
        )}
      </div>

      <OctantButton
        className="execution-profile-workflow__reload"
        disabled={controller.busy}
        onClick={() => void controller.reload()}
        type="button"
        variant="ghost"
      >
        <RotateCcw aria-hidden="true" size={12} />
        Reload profiles
      </OctantButton>
    </>
  );

  return (
    <section
      aria-label="Execution profiles"
      className={`execution-profile-workflow execution-profile-workflow--${props.variant}`}
    >
      {props.variant === "composer" ? (
        <OctantPopover
          align="end"
          className="execution-profile-workflow__body"
          onOpenChange={setOpen}
          open={open}
          side="top"
          title="Execution profile options"
          trigger={
            <>
              <UserRoundCog aria-hidden="true" size={14} />
              <span>{selectedName}</span>
              <ChevronDown aria-hidden="true" size={12} />
            </>
          }
          triggerClassName="execution-profile-workflow__trigger"
          triggerLabel={`Execution profile: ${selectedName}`}
          triggerVariant="outline"
        >
          {body}
        </OctantPopover>
      ) : (
        <>
          <header className="execution-profile-workflow__header">
            <div>
              <p className="execution-profile-workflow__eyebrow">Execution context</p>
              <h2>Profiles</h2>
              <p>
                Reusable behavior defaults are resolved by the server and never change Project,
                root, worktree, host, extension trust, or authority.
              </p>
            </div>
            <OctantButton onClick={() => setEditing("create")} type="button" variant="outline">
              <Plus aria-hidden="true" size={14} />
              Create profile
            </OctantButton>
          </header>

          {!open ? null : <div className="execution-profile-workflow__body">{body}</div>}
        </>
      )}

      <ProfileForm
        controller={controller}
        key={
          editing === undefined ? "closed" : editing === "create" ? "create" : String(editing.id)
        }
        mode={editing === "create" ? "create" : "edit"}
        onClose={() => setEditing(undefined)}
        open={editing !== undefined}
        {...(editing === "create" || editing === undefined ? {} : { profile: editing })}
      />

      <OctantDialog
        className="execution-profile-workflow__confirm"
        label={`Delete ${confirmDelete?.displayName ?? ""}`}
        onClose={() => setConfirmDelete(undefined)}
        open={confirmDelete !== undefined}
      >
        <p>Delete this profile? This cannot be undone.</p>
        <div>
          <OctantButton onClick={() => setConfirmDelete(undefined)} type="button" variant="ghost">
            Cancel
          </OctantButton>
          <OctantButton
            aria-label={`Confirm delete ${confirmDelete?.displayName ?? ""}`}
            disabled={controller.busy}
            onClick={() => {
              if (confirmDelete === undefined) return;
              void controller.deleteProfile(confirmDelete).then(() => setConfirmDelete(undefined));
            }}
            type="button"
            variant="destructive"
          >
            Delete profile
          </OctantButton>
        </div>
      </OctantDialog>
    </section>
  );
}

function ResolutionReceipt(props: { readonly controller: ExecutionProfileController }) {
  const receipt = props.controller.receipt;
  if (receipt === undefined) {
    return (
      <div className="execution-profile-workflow__receipt" role="status">
        {props.controller.status === "loading"
          ? "Loading profiles…"
          : props.controller.status === "resolving"
            ? "Resolving current provider, model, profile, and host facts…"
            : "Select a profile to resolve its effective execution context."}
      </div>
    );
  }
  const entry = props.controller.entries.find(
    (candidate) =>
      String(candidate.providerInstanceId) === String(receipt.providerInstanceId) &&
      String(candidate.modelId) === String(receipt.modelId) &&
      String(candidate.profileId) === String(receipt.profileId),
  );
  return (
    <div className="execution-profile-workflow__receipt" aria-label="Resolution receipt">
      {/* The system `.kv` fact table lays out dt/dd pairs itself, so the
          pairs are direct children rather than wrapped in divs. */}
      <dl className="kv">
        <dt>Provider</dt>
        <dd>{entry?.providerDisplayName ?? String(receipt.providerInstanceId)}</dd>
        <dt>Model</dt>
        <dd>{entry?.modelDisplayName ?? String(receipt.modelId)}</dd>
        <dt>Profile</dt>
        <dd>{entry?.profileDisplayName ?? "No profile"}</dd>
        <dt>Host</dt>
        <dd>{entry?.hostLabel ?? String(receipt.hostId)}</dd>
        <dt>Permissions</dt>
        <dd>{permissionLabel(receipt.effectivePermissions)}</dd>
        <dt>Resolved from</dt>
        <dd>{sourceLabel(receipt.source)}</dd>
      </dl>
      <p>Fallback: {receipt.fallbackChain.map(sourceLabel).join(" → ")}</p>
      {receipt.downgradeReasons.map((reason) => (
        <p
          className="execution-profile-workflow__downgrade"
          key={`${reason.step}:${reason.reason}`}
        >
          {sourceLabel(reason.step)}: {reason.reason}
        </p>
      ))}
    </div>
  );
}

function ProfileForm(props: {
  readonly controller: ExecutionProfileController;
  readonly mode: "create" | "edit";
  readonly onClose: () => void;
  readonly open: boolean;
  readonly profile?: AgentProfile;
}) {
  const initial = props.profile;
  const [displayName, setDisplayName] = useState(initial?.displayName ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [instructions, setInstructions] = useState(initial?.instructions ?? "");
  const [skills, setSkills] = useState(initial?.approvedSkillIds.join(", ") ?? "");
  const [tools, setTools] = useState(initial?.toolConstraints.join(", ") ?? "");
  const [modelConstraint, setModelConstraint] = useState(
    initial?.modelConstraints[0] === undefined ? "" : String(initial.modelConstraints[0]),
  );
  const [policy, setPolicy] = useState(initial?.defaultExecutionPolicy ?? "approval-gated");
  const [persistence, setPersistence] = useState(
    initial?.defaultPermissionPersistence ?? "current-session",
  );
  const [scopeKind, setScopeKind] = useState(props.controller.scope.scopeKind);
  const compatibleModes = initial?.compatibleModes ?? [props.controller.mode];

  async function submit(event: FormEvent) {
    event.preventDefault();
    const common = {
      displayName: displayName.trim(),
      ...(description.trim() === "" ? {} : { description: description.trim() }),
      ...(instructions.trim() === "" ? {} : { instructions: instructions.trim() }),
      approvedSkillIds: splitList(skills),
      toolConstraints: splitList(tools),
      modelConstraints:
        modelConstraint.trim() === "" ? [] : [modelConstraint.trim() as ProviderModelId],
      defaultExecutionPolicy: policy,
      defaultPermissionPersistence: persistence,
      compatibleModes,
    } satisfies Omit<CreateExecutionProfileInput, "scope">;
    if (props.mode === "create") {
      await props.controller.createProfile({
        ...common,
        scope:
          scopeKind === "user"
            ? { scopeKind: "user", scopeRef: "local-user" }
            : props.controller.scope,
      });
    } else if (initial !== undefined) {
      await props.controller.updateProfile({ ...initial, ...common });
    }
    props.onClose();
  }

  return (
    <OctantDialog
      className="execution-profile-workflow__form"
      label={`${props.mode === "create" ? "Create" : "Edit"} execution profile`}
      onClose={props.onClose}
      open={props.open}
    >
      <form onSubmit={(event) => void submit(event)}>
        <h3>
          {props.mode === "create" ? "Create execution profile" : `Edit ${initial?.displayName}`}
        </h3>
        <label>
          <span>Profile name</span>
          <OctantInput
            aria-label="Profile name"
            onChange={(event) => setDisplayName(event.target.value)}
            required
            value={displayName}
          />
        </label>
        <label>
          <span>Description</span>
          <OctantInput
            aria-label="Profile description"
            onChange={(event) => setDescription(event.target.value)}
            value={description}
          />
        </label>
        <label>
          <span>Approved instructions</span>
          <OctantTextarea
            aria-label="Approved instructions"
            onChange={(event) => setInstructions(event.target.value)}
            rows={3}
            value={instructions}
          />
        </label>
        <label>
          <span>Approved skills (comma separated)</span>
          <OctantInput
            aria-label="Approved skills"
            onChange={(event) => setSkills(event.target.value)}
            value={skills}
          />
        </label>
        <label>
          <span>Tool constraints (comma separated)</span>
          <OctantInput
            aria-label="Tool constraints"
            onChange={(event) => setTools(event.target.value)}
            value={tools}
          />
        </label>
        <label>
          <span>Model constraint</span>
          <OctantInput
            aria-label="Model constraint"
            onChange={(event) => setModelConstraint(event.target.value)}
            placeholder="Any model"
            value={modelConstraint}
          />
        </label>
        <label>
          <span>Execution policy</span>
          <OctantNativeSelect
            aria-label="Execution policy"
            onChange={(event) => setPolicy(event.target.value as typeof policy)}
            value={policy}
          >
            <option value="plan">Plan (read-only)</option>
            <option value="approval-gated">Approval gated</option>
            <option value="auto-accept-edits">Auto-accept edits</option>
            <option value="full-access">Full access (still bounded by Project)</option>
          </OctantNativeSelect>
        </label>
        <label>
          <span>Permission persistence</span>
          <OctantNativeSelect
            aria-label="Permission persistence"
            onChange={(event) => setPersistence(event.target.value as typeof persistence)}
            value={persistence}
          >
            <option value="current-session">Current session</option>
            <option value="project-default">Project default</option>
          </OctantNativeSelect>
        </label>
        {props.mode === "create" ? (
          <label>
            <span>Profile scope</span>
            <OctantNativeSelect
              aria-label="Profile scope"
              onChange={(event) => setScopeKind(event.target.value as typeof scopeKind)}
              value={scopeKind}
            >
              <option value="user">User default</option>
              <option value={props.controller.scope.scopeKind}>
                {scopeLabel(props.controller.scope.scopeKind)}
              </option>
            </OctantNativeSelect>
          </label>
        ) : null}
        <p className="execution-profile-workflow__form-note">
          This profile is compatible with {compatibleModes.map(modeLabel).join(", ")}. Selecting it
          for a draft is a one-off override and does not grant authority.
        </p>
        <div className="execution-profile-workflow__form-actions">
          <OctantButton onClick={props.onClose} type="button" variant="ghost">
            Cancel
          </OctantButton>
          <OctantButton disabled={props.controller.busy || displayName.trim() === ""} type="submit">
            {props.mode === "create" ? "Save new profile" : "Save profile changes"}
          </OctantButton>
        </div>
      </form>
    </OctantDialog>
  );
}

function splitList(value: string): ReadonlyArray<string> {
  return value
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function permissionLabel(permissions: ExecutionResolutionReceiptPermissions): string {
  const enabled = [
    permissions.filesystem ? "Filesystem" : undefined,
    permissions.shell ? "Shell" : undefined,
    permissions.git ? "Git" : undefined,
    permissions.network ? "Network" : undefined,
    permissions.tools ? "Tools" : undefined,
    permissions.subagents ? "Subagents" : undefined,
  ].filter((value): value is string => value !== undefined);
  return enabled.length === 0 ? "Read-only" : enabled.join(", ");
}

type ExecutionResolutionReceiptPermissions = NonNullable<
  ExecutionProfileController["receipt"]
>["effectivePermissions"];

function sourceLabel(source: string): string {
  if (source === "one-off-override") return "One-off override";
  if (source === "project-default") return "Project default";
  if (source === "mode-default") return "Mode default";
  if (source === "user-default") return "User default";
  return "No profile";
}

function scopeLabel(scope: string): string {
  if (scope === "project") return "Current Project";
  if (scope === "mode") return "Current mode";
  if (scope === "one-off") return "Current thread";
  return "User default";
}

function modeLabel(mode: OctantMode): string {
  return mode === "code" ? "Code" : mode === "work" ? "Work" : "Chat";
}
