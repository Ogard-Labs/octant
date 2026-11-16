import { useEffect, useId, useState, useRef } from "react";
import {
  decodeSandboxPolicy,
  decodeSandboxRestrictionsCommand,
  type SandboxPolicy,
  type SandboxRestrictionsScope,
  type SandboxRestrictionsSnapshot,
} from "@octant/contracts/sandbox-policy";
import type { SandboxRestrictionsClient } from "@octant/client-runtime/sandbox-restrictions-client";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { OctantFieldError } from "../ui/base/OctantField";
import { SettingsSection, SettingRow, SettingsCompactRow, SettingsState } from "./primitives";

export interface SandboxSettingsScope {
  readonly id: string;
  readonly label: string;
  readonly scope: SandboxRestrictionsScope;
}
export interface SandboxRestrictionsSettingsProps {
  readonly client: SandboxRestrictionsClient | undefined;
  readonly scopes?: ReadonlyArray<SandboxSettingsScope> | undefined;
  readonly initialScope?: SandboxRestrictionsScope | undefined;
  readonly focusedSetting?: string | undefined;
}
const defaultScopes: ReadonlyArray<SandboxSettingsScope> = [
  { id: "code", label: "Settings · Code", scope: { kind: "settings", mode: "code" } },
  { id: "work", label: "Settings · Work", scope: { kind: "settings", mode: "work" } },
];
const initialPolicy = (): SandboxPolicy =>
  decodeSandboxPolicy({
    schemaVersion: 1,
    revision: 0,
    filesystem: { readOnlyRoots: [], readWriteRoots: [], protectedPaths: [] },
    network: "existing-policy",
    credentials: "existing-policy",
    hostServices: "existing-policy",
  });

type SandboxChange = {
  [Kind in import("@octant/contracts/sandbox-policy").SandboxRestrictionsCommand["kind"]]: Omit<
    Extract<
      import("@octant/contracts/sandbox-policy").SandboxRestrictionsCommand,
      { readonly kind: Kind }
    >,
    "expectedVersion"
  >;
}[import("@octant/contracts/sandbox-policy").SandboxRestrictionsCommand["kind"]];

export function SandboxRestrictionsSettings(props: SandboxRestrictionsSettingsProps) {
  const scopes = [...defaultScopes, ...(props.scopes ?? [])];
  const [scopeId, setScopeId] = useState(
    () =>
      scopes.find((choice) => JSON.stringify(choice.scope) === JSON.stringify(props.initialScope))
        ?.id ?? "code",
  );
  const scope = scopes.find((choice) => choice.id === scopeId)?.scope ?? defaultScopes[0]?.scope;
  const [snapshot, setSnapshot] = useState<SandboxRestrictionsSnapshot>();
  const [draft, setDraft] = useState<SandboxPolicy>(initialPolicy);
  const [path, setPath] = useState("");
  const [access, setAccess] = useState("read-only");
  const [serviceAddress, setServiceAddress] = useState("");
  const [serviceProblem, setServiceProblem] = useState<string>();
  const serviceInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [loadFailed, setLoadFailed] = useState(false);
  const [reload, setReload] = useState(0);
  const drafts = useRef(new Map<string, SandboxPolicy>());
  const pathId = useId();
  const serviceId = useId();
  const scopeKey = JSON.stringify(scope);
  useEffect(() => {
    if (props.initialScope !== undefined) {
      const choice = scopes.find(
        (item) => JSON.stringify(item.scope) === JSON.stringify(props.initialScope),
      );
      if (choice !== undefined) setScopeId(choice.id);
    }
  }, [JSON.stringify(props.initialScope)]);
  const updateDraft = (next: SandboxPolicy) => {
    drafts.current.set(scopeKey, next);
    setDraft(next);
  };
  useEffect(() => {
    if (props.client === undefined || scope === undefined) return;
    const controller = new AbortController();
    setSnapshot(undefined);
    setProblem(undefined);
    setLoadFailed(false);
    void props.client
      .settings(scope, controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return;
        setSnapshot(value);
        setDraft(drafts.current.get(scopeKey) ?? value.policy ?? initialPolicy());
      })
      .catch(() => {
        if (!controller.signal.aborted) setLoadFailed(true);
      });
    const timer = setInterval(() => {
      void props.client
        ?.settings(scope, controller.signal)
        .then((value) => {
          if (controller.signal.aborted) return;
          setSnapshot((previous) =>
            previous === undefined
              ? value
              : {
                  ...previous,
                  denials: value.denials,
                  running: value.running,
                  strict: value.strict,
                  strictSource: value.strictSource,
                  legacyStrict: value.legacyStrict,
                  activeStrict: value.activeStrict,
                  activeLegacyStrict: value.activeLegacyStrict,
                  activePolicy: value.activePolicy,
                  pending: value.pending,
                  summary: value.summary,
                  runtimeDetails: value.runtimeDetails,
                  capabilities: value.capabilities,
                  limitations: value.limitations,
                  enrollmentEnabled: value.enrollmentEnabled,
                },
          );
        })
        .catch(() => undefined);
    }, 3000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [props.client, scopeKey, reload]);

  async function change(value: SandboxChange) {
    if (props.client === undefined || snapshot === undefined) return;
    setBusy(true);
    setProblem(undefined);
    try {
      const result = await props.client.change(
        decodeSandboxRestrictionsCommand({ ...value, expectedVersion: snapshot.version }),
      );
      if (result.kind === "sandbox-restrictions-refused") {
        setProblem(result.message);
        return;
      }
      const refreshed =
        scope === undefined || JSON.stringify(scope) === JSON.stringify(result.scope)
          ? result
          : await props.client.settings(scope);
      drafts.current.delete(scopeKey);
      setSnapshot(refreshed);
      setDraft(refreshed.policy ?? initialPolicy());
    } catch {
      setProblem(
        "Sandbox restrictions could not be saved. Your draft is still here; retry or reload.",
      );
    } finally {
      setBusy(false);
    }
  }
  const addFolder = () => {
    try {
      const field = access === "read-only" ? "readOnlyRoots" : "readWriteRoots";
      const next = decodeSandboxPolicy({
        ...draft,
        filesystem: {
          ...draft.filesystem,
          [field]: [...new Set([...draft.filesystem[field], path.trim()])],
        },
      });
      updateDraft(next);
      setPath("");
      setProblem(undefined);
    } catch {
      setProblem("Use an absolute folder path without . or .. segments.");
    }
  };
  const addService = () => {
    try {
      const match = /^(127\.0\.0\.1|\[::1\]):([1-9][0-9]{0,4})$/.exec(serviceAddress.trim());
      if (match === null) throw new Error("Invalid endpoint");
      const service = { host: match[1] === "[::1]" ? "::1" : match[1], port: Number(match[2]) };
      updateDraft(
        decodeSandboxPolicy({
          ...draft,
          hostServices: "blocked",
          localServices: [
            ...(draft.localServices ?? []).filter(
              (entry) => entry.host !== service.host || entry.port !== service.port,
            ),
            service,
          ],
        }),
      );
      setServiceAddress("");
      setServiceProblem(undefined);
      serviceInput.current?.focus();
    } catch {
      setServiceProblem("Use 127.0.0.1:port or [::1]:port, with a port from 1 to 65535.");
      serviceInput.current?.focus();
    }
  };
  const folders = [
    ...draft.filesystem.readOnlyRoots.map((root) => ({
      root,
      field: "readOnlyRoots" as const,
      label: "Read only",
    })),
    ...draft.filesystem.readWriteRoots.map((root) => ({
      root,
      field: "readWriteRoots" as const,
      label: "Read and write",
    })),
  ];
  return (
    <SettingsSection
      title="Configure protections"
      description="Configure supported protections for Strict. Saving a policy keeps your Strict choice unchanged."
      id="settings-sandbox-restrictions"
    >
      {props.client === undefined ? (
        <SettingsState kind="empty">
          Connect to the host to review its sandbox restrictions.
        </SettingsState>
      ) : (
        <>
          <SettingRow
            settingId="sandbox-restrictions"
            scope={
              snapshot?.scope.kind === "project"
                ? "project"
                : snapshot?.scope.kind === "session"
                  ? "thread"
                  : "host"
            }
            focused={props.focusedSetting === "sandbox-restrictions"}
            label="Applies to"
            description="Session choices override Project choices, which override Settings."
          >
            <OctantSelectField
              aria-label="Sandbox policy scope"
              value={scopeId}
              options={scopes.map((item) => ({ id: item.id, label: item.label }))}
              disabled={busy}
              onValueChange={setScopeId}
            />
          </SettingRow>
          {snapshot === undefined ? (
            <SettingsState kind={loadFailed ? "error" : "loading"}>
              {loadFailed
                ? "Could not read sandbox restrictions."
                : "Loading sandbox restrictions…"}
              {loadFailed ? (
                <OctantButton onClick={() => setReload((value) => value + 1)}>Retry</OctantButton>
              ) : null}
            </SettingsState>
          ) : (
            <>
              {snapshot.enrollmentEnabled === false ? (
                <SettingsState kind="empty">
                  New policy enrollment is unavailable on this host. Review Advanced protections and
                  limitations; saved restrictions remain enforced.
                </SettingsState>
              ) : null}
              <p className="oct-meta">
                {snapshot.legacyStrict === true ? "Legacy sandbox is" : "Strict is"}{" "}
                {snapshot.strict === true ? "on" : "off"} · {snapshot.strictSource ?? "default"}.
                Saved protections apply when Strict is on; required approvals remain.
              </p>
              <SettingRow
                settingId="sandbox-policy-summary"
                scope={
                  snapshot?.scope.kind === "project"
                    ? "project"
                    : snapshot?.scope.kind === "session"
                      ? "thread"
                      : "host"
                }
                label="Effective protection"
                description={snapshot.summary}
              >
                <span className="oct-meta">
                  {snapshot.running
                    ? snapshot.activeStrict === true
                      ? snapshot.activeLegacyStrict
                        ? "Legacy sandbox active"
                        : "Strict active"
                      : "Strict off for this turn"
                    : snapshot.strict === true
                      ? snapshot.legacyStrict
                        ? "Legacy sandbox on"
                        : "Strict on"
                      : "Strict off"}
                  {snapshot.pending === true ? " · changes pending" : ""}
                </span>
              </SettingRow>
              {snapshot.running ? (
                <p className="oct-meta">
                  A turn is running. Its admitted policy stays in effect. Stop the turn and start a
                  new run to apply changes; changing settings cannot alter its running processes.
                </p>
              ) : null}
              <SettingRow
                settingId="sandbox-policy-folders"
                scope={
                  snapshot?.scope.kind === "project"
                    ? "project"
                    : snapshot?.scope.kind === "session"
                      ? "thread"
                      : "host"
                }
                label="Allowed folders"
                description="The Project remains writable; add only the extra folders this work needs."
              >
                <span className="oct-meta">{folders.length} extra folders</span>
              </SettingRow>
              {folders.map(({ root, field, label }) => (
                <SettingsCompactRow labelWraps key={`${field}:${root}`} label={root} meta={label}>
                  <OctantButton
                    disabled={busy}
                    variant="ghost"
                    onClick={() =>
                      updateDraft({
                        ...draft,
                        filesystem: {
                          ...draft.filesystem,
                          [field]: draft.filesystem[field].filter((item) => item !== root),
                        },
                      })
                    }
                    aria-label={`Remove ${label.toLowerCase()} folder ${root}`}
                  >
                    Remove
                  </OctantButton>
                </SettingsCompactRow>
              ))}
              <SettingRow
                settingId="sandbox-policy-add-folder"
                scope={
                  snapshot?.scope.kind === "project"
                    ? "project"
                    : snapshot?.scope.kind === "session"
                      ? "thread"
                      : "host"
                }
                label="Add folder"
                description="Use the exact folder on this host."
              >
                <div className="flex w-full min-w-0 flex-wrap items-center gap-2">
                  <label className="sr-only" htmlFor={pathId}>
                    Allowed folder path
                  </label>
                  <OctantInput
                    id={pathId}
                    value={path}
                    onChange={(event) => setPath(event.target.value)}
                    disabled={busy}
                    placeholder="/path/to/shared-library"
                  />
                  <OctantSelectField
                    aria-label="Folder access"
                    value={access}
                    onValueChange={setAccess}
                    disabled={busy}
                    options={[
                      { id: "read-only", label: "Read only" },
                      { id: "read-write", label: "Read and write" },
                    ]}
                  />
                  <OctantButton disabled={busy || path.trim() === ""} onClick={addFolder}>
                    Add
                  </OctantButton>
                </div>
              </SettingRow>
              <SettingRow
                settingId="sandbox-policy-blocked-actions"
                scope={
                  snapshot?.scope.kind === "project"
                    ? "project"
                    : snapshot?.scope.kind === "session"
                      ? "thread"
                      : "host"
                }
                label="Blocked actions"
                description="Writes outside allowed folders and host administration stay confined."
              >
                <span className="oct-meta">
                  {snapshot.strict === true ? "Strict boundary" : "Saved for Strict"}
                </span>
              </SettingRow>
              <SettingRow
                settingId="sandbox-policy-network"
                scope={
                  snapshot?.scope.kind === "project"
                    ? "project"
                    : snapshot?.scope.kind === "session"
                      ? "thread"
                      : "host"
                }
                label="Network"
                description="The model connection and host-owned tool bridges remain separate channels."
              >
                <OctantSelectField
                  aria-label="Sandbox network"
                  value={draft.network}
                  disabled={busy}
                  options={[
                    { id: "existing-policy", label: "Follow Safe networks settings" },
                    { id: "deny", label: "Block network access" },
                    ...(draft.network === "unrestricted"
                      ? [
                          {
                            id: "unrestricted",
                            label:
                              "Unrestricted (previous choice; cannot bypass Strict Network limits)",
                          },
                        ]
                      : []),
                  ]}
                  onValueChange={(network) => {
                    if (
                      network === "deny" ||
                      network === "unrestricted" ||
                      network === "existing-policy"
                    )
                      updateDraft({ ...draft, network });
                  }}
                />
              </SettingRow>
              <SettingRow
                settingId="sandbox-policy-services"
                scope={
                  snapshot?.scope.kind === "project"
                    ? "project"
                    : snapshot?.scope.kind === "session"
                      ? "thread"
                      : "host"
                }
                label="Host services"
                description="Configure whether Strict blocks ambient local services. Provider and host-owned control bridges remain separate."
              >
                <OctantSelectField
                  aria-label="Strict host services"
                  value={draft.hostServices}
                  disabled={busy || !snapshot.capabilities.blockedHostServices}
                  options={[
                    { id: "existing-policy", label: "Standard Strict rules" },
                    { id: "blocked", label: "Block ambient host services" },
                  ]}
                  onValueChange={(hostServices) => {
                    if (hostServices === "existing-policy" || hostServices === "blocked")
                      updateDraft({
                        ...draft,
                        hostServices,
                        ...(hostServices === "existing-policy" ? { localServices: [] } : {}),
                      });
                  }}
                />
              </SettingRow>
              <SettingRow
                settingId="sandbox-policy-local-services"
                scope={
                  snapshot.scope.kind === "project"
                    ? "project"
                    : snapshot.scope.kind === "session"
                      ? "thread"
                      : "host"
                }
                label="Local service exceptions"
                description="Allow an exact address and port through the proxy while blocking other ambient host services; the service's effects are a separate authority."
              >
                <div className="settings-section-stack">
                  {(draft.localServices ?? []).map((service) => {
                    const endpoint = `${service.host === "::1" ? "[::1]" : service.host}:${service.port}`;
                    return (
                      <SettingsCompactRow key={endpoint} label={endpoint}>
                        <OctantButton
                          variant="ghost"
                          disabled={busy}
                          aria-label={`Remove local service ${endpoint}`}
                          onClick={() =>
                            updateDraft({
                              ...draft,
                              localServices: draft.localServices?.filter(
                                (entry) => entry !== service,
                              ),
                            })
                          }
                        >
                          Remove
                        </OctantButton>
                      </SettingsCompactRow>
                    );
                  })}
                  <label htmlFor={serviceId}>Local service address and port</label>
                  <div className="settings-view__actions">
                    <OctantInput
                      id={serviceId}
                      ref={serviceInput}
                      value={serviceAddress}
                      onChange={(event) => {
                        setServiceAddress(event.target.value);
                        setServiceProblem(undefined);
                      }}
                      disabled={busy || !snapshot.capabilities.blockedHostServices}
                      placeholder="127.0.0.1:5173"
                      aria-invalid={serviceProblem !== undefined}
                      aria-describedby={
                        serviceProblem === undefined ? undefined : `${serviceId}-error`
                      }
                    />
                    <OctantButton
                      disabled={
                        busy ||
                        !snapshot.capabilities.blockedHostServices ||
                        serviceAddress.trim() === ""
                      }
                      onClick={addService}
                    >
                      Add local service
                    </OctantButton>
                  </div>
                  {serviceProblem === undefined ? null : (
                    <OctantFieldError id={`${serviceId}-error`}>{serviceProblem}</OctantFieldError>
                  )}
                </div>
              </SettingRow>
              <SettingRow
                settingId="sandbox-policy-credentials"
                scope={
                  snapshot?.scope.kind === "project"
                    ? "project"
                    : snapshot?.scope.kind === "session"
                      ? "thread"
                      : "host"
                }
                label="Personal files and credentials"
                description="Protected-file rules stay active. Provider sign-in uses its scoped channel; saved credential commands keep their separate one-use recipient and account review in Secret stores."
              >
                <span className="oct-meta">
                  {snapshot.strict === true ? "Standard Strict rules" : "Saved for Strict"}
                </span>
              </SettingRow>
              <details>
                <summary>Advanced protections and limitations</summary>
                {snapshot.limitations.map((limitation) => (
                  <p className="oct-meta" key={limitation}>
                    {limitation}
                  </p>
                ))}
                {(snapshot.runtimeDetails ?? []).map((details, index) => (
                  <div key={`${details.backend}:${index}`}>
                    <p className="oct-meta">
                      {details.provider} · {details.backend}
                    </p>
                    <p className="oct-meta">
                      Additional read access: {details.reads.join(", ") || "none"}
                    </p>
                    <p className="oct-meta">
                      Private and additional writable storage: {details.writes.join(", ") || "none"}
                    </p>
                    <p className="oct-meta">
                      Explicit home and sign-in exemptions:{" "}
                      {details.authentication.join(", ") || "none"}
                    </p>
                  </div>
                ))}
                {(snapshot.runtimeDetails?.length ?? 0) === 0 ? (
                  <p className="oct-meta">
                    Toolchain and private-storage grants appear here while a policy turn is running.
                  </p>
                ) : null}
                <p className="oct-meta">
                  Browser actions, external connectors and remote provider calls use their separate
                  permissions.
                </p>
              </details>
              {problem === undefined ? null : <OctantFieldError>{problem}</OctantFieldError>}
              <div className="settings-view__actions">
                <OctantButton
                  disabled={busy || snapshot.enrollmentEnabled === false}
                  onClick={() =>
                    void change({ kind: "set-policy", scope: snapshot.scope, policy: draft })
                  }
                >
                  {busy ? "Saving…" : "Save sandbox restrictions"}
                </OctantButton>
                <OctantButton
                  disabled={busy || snapshot.source === "legacy"}
                  variant="outline"
                  onClick={() => void change({ kind: "inherit-policy", scope: snapshot.scope })}
                >
                  Use inherited policy
                </OctantButton>
                <OctantButton
                  disabled={busy}
                  variant="ghost"
                  onClick={() => {
                    drafts.current.delete(scopeKey);
                    setReload((value) => value + 1);
                  }}
                >
                  Reload
                </OctantButton>
              </div>
              {snapshot.denials.length === 0 ? (
                <p className="oct-meta">No recently blocked actions</p>
              ) : (
                snapshot.denials.map((denial) => (
                  <div key={denial.id} className="settings-section-stack">
                    <p>
                      {denial.message} {denial.count > 1 ? `(${denial.count} attempts)` : ""}
                    </p>
                    <p className="oct-meta">{denial.remedy}</p>
                    {denial.grantable ? (
                      <p className="oct-meta">
                        Grant {denial.operation} access to {denial.resource}. Saved for future runs;
                        this does not enable Strict.
                        {denial.localService === undefined
                          ? null
                          : " This permits the named service's effects as a separate authority; other ambient host services stay blocked."}
                      </p>
                    ) : null}
                    <div className="settings-view__actions">
                      {denial.grantable ? (
                        <>
                          <OctantButton
                            disabled={busy}
                            onClick={() =>
                              void change({
                                kind: "grant-denial",
                                denialId: denial.id,
                                duration: "session",
                              })
                            }
                          >
                            Allow for this session
                          </OctantButton>
                          <OctantButton
                            disabled={busy}
                            variant="outline"
                            onClick={() =>
                              void change({
                                kind: "grant-denial",
                                denialId: denial.id,
                                duration: "project",
                              })
                            }
                          >
                            Remember for this Project
                          </OctantButton>
                        </>
                      ) : null}
                      <OctantButton
                        disabled={busy}
                        variant="ghost"
                        onClick={() => void change({ kind: "keep-blocked", denialId: denial.id })}
                      >
                        Keep blocked
                      </OctantButton>
                    </div>
                  </div>
                ))
              )}
            </>
          )}
        </>
      )}
    </SettingsSection>
  );
}
