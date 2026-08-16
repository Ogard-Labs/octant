import type { AgentProfileClient } from "@octant/client-runtime";
import type {
  AgentProfile,
  AgentProfileId,
  AgentProfileScope,
  ExecutionContextPickerEntry,
  ExecutionResolutionReceipt,
} from "@octant/contracts/agent-profile";
import type { HostHealth } from "@octant/contracts/host";
import type { OctantMode } from "@octant/contracts/modes";
import type {
  PermissionPersistence,
  ProviderExecutionPolicy,
  ProviderInstanceId,
  ProviderModelId,
} from "@octant/contracts/providers";
import type { HostId } from "@octant/contracts/shell";
import { buildExecutionContextPickerEntries, type PickerGroup } from "@octant/domain";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type ExecutionProfileStatus =
  | "loading"
  | "ready"
  | "resolving"
  | "resolved"
  | "unsupported"
  | "error";

export interface CreateExecutionProfileInput {
  readonly displayName: string;
  readonly description?: string;
  readonly instructions?: string;
  readonly approvedSkillIds: ReadonlyArray<string>;
  readonly toolConstraints: ReadonlyArray<string>;
  readonly modelConstraints: ReadonlyArray<ProviderModelId>;
  readonly defaultExecutionPolicy: ProviderExecutionPolicy;
  readonly defaultPermissionPersistence: PermissionPersistence;
  readonly compatibleModes: ReadonlyArray<OctantMode>;
  readonly scope: AgentProfileScope;
}

export interface ExecutionProfileController {
  readonly mode: OctantMode;
  readonly scope: AgentProfileScope;
  readonly profiles: ReadonlyArray<AgentProfile>;
  readonly entries: ReadonlyArray<ExecutionContextPickerEntry>;
  readonly selectedEntry: ExecutionContextPickerEntry | undefined;
  readonly selectedProfile: AgentProfile | undefined;
  readonly receipt: ExecutionResolutionReceipt | undefined;
  readonly status: ExecutionProfileStatus;
  readonly busy: boolean;
  readonly message: string | undefined;
  readonly selectEntry: (entry: ExecutionContextPickerEntry) => void;
  readonly selectProfile: (profileId: AgentProfileId | undefined) => void;
  readonly createProfile: (input: CreateExecutionProfileInput) => Promise<void>;
  readonly updateProfile: (profile: AgentProfile) => Promise<void>;
  readonly deleteProfile: (profile: AgentProfile) => Promise<void>;
  readonly reload: () => Promise<void>;
}

export interface UseExecutionProfileControllerOptions {
  readonly client: AgentProfileClient;
  readonly hostHealth?: HostHealth;
  readonly hostId: HostId;
  readonly hostLabel: string;
  readonly mode: OctantMode;
  readonly onSelectProvider: (selection: {
    readonly providerInstanceId: ProviderInstanceId;
    readonly modelId: ProviderModelId;
  }) => void;
  readonly profileSelectionStorageKey: string;
  readonly projectExecutionPolicy: ProviderExecutionPolicy;
  readonly providerGroups: ReadonlyArray<PickerGroup>;
  readonly selectedProviderInstanceId?: ProviderInstanceId;
  readonly selectedModelId?: ProviderModelId;
  readonly scope: AgentProfileScope;
  readonly storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
}

export function useExecutionProfileController(
  options: UseExecutionProfileControllerOptions,
): ExecutionProfileController {
  const storage = options.storage ?? browserStorage();
  const [profiles, setProfiles] = useState<ReadonlyArray<AgentProfile>>([]);
  const [selectedProfileId, setSelectedProfileId] = useState<AgentProfileId | undefined>(() =>
    readStoredProfileId(storage, options.profileSelectionStorageKey),
  );
  const [receipt, setReceipt] = useState<ExecutionResolutionReceipt>();
  const [status, setStatus] = useState<ExecutionProfileStatus>("loading");
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);
  const loadSequence = useRef(0);
  const resolveSequence = useRef(0);

  const reload = useCallback(async () => {
    const sequence = ++loadSequence.current;
    setStatus("loading");
    setMessage(undefined);
    try {
      const loaded = await options.client.list();
      if (sequence !== loadSequence.current) return;
      setProfiles(loaded);
      setStatus("ready");
    } catch (error) {
      if (sequence !== loadSequence.current) return;
      setStatus("error");
      setMessage(actionableMessage(error, "Profiles could not be loaded."));
    }
  }, [options.client]);

  useEffect(() => {
    void reload();
    return () => {
      loadSequence.current += 1;
      resolveSequence.current += 1;
    };
  }, [reload]);

  useEffect(() => {
    setSelectedProfileId(readStoredProfileId(storage, options.profileSelectionStorageKey));
  }, [options.profileSelectionStorageKey, storage]);

  const selectedProfile = useMemo(
    () => profiles.find((profile) => String(profile.id) === String(selectedProfileId)),
    [profiles, selectedProfileId],
  );

  useEffect(() => {
    if (selectedProfileId === undefined || status === "loading") return;
    if (selectedProfile !== undefined) return;
    setSelectedProfileId(undefined);
    removeStoredProfile(storage, options.profileSelectionStorageKey);
    setReceipt(undefined);
    setStatus("unsupported");
    setMessage("The restored profile no longer exists. Choose another profile and resolve again.");
  }, [options.profileSelectionStorageKey, selectedProfile, selectedProfileId, status, storage]);

  const providers = useMemo(
    () =>
      options.providerGroups.map((group) => ({
        instanceId: group.instance.id,
        displayName: group.instance.displayName,
        readiness: group.readiness,
        models: group.sections.flatMap((section) =>
          section.models.map((picker) => ({
            id: picker.model.id,
            displayName: picker.model.displayName,
          })),
        ),
      })),
    [options.providerGroups],
  );
  const providerFactKey = JSON.stringify(
    options.providerGroups.map((group) => ({
      providerInstanceId: group.instance.id,
      readiness: group.readiness,
      executionHost: group.executionHost,
      models: group.sections.flatMap((section) =>
        section.models.map((picker) => ({
          modelId: picker.model.id,
          toolCapable: picker.toolCapable,
          unavailableReason: picker.unavailableReason,
        })),
      ),
    })),
  );

  const entries = useMemo(
    () =>
      buildExecutionContextPickerEntries({
        providers,
        profiles,
        hostId: String(options.hostId),
        hostLabel: options.hostLabel,
        mode: options.mode,
        projectExecutionPolicy: options.projectExecutionPolicy,
      }),
    [
      options.hostId,
      options.hostLabel,
      options.mode,
      options.projectExecutionPolicy,
      profiles,
      providers,
    ],
  );

  const selectedProviderInstanceId =
    options.selectedProviderInstanceId ?? entries[0]?.providerInstanceId;
  const selectedModelId = options.selectedModelId ?? entries[0]?.modelId;
  const selectedEntry = useMemo(
    () =>
      entries.find(
        (entry) =>
          String(entry.providerInstanceId) === String(selectedProviderInstanceId) &&
          String(entry.modelId) === String(selectedModelId) &&
          String(entry.profileId) === String(selectedProfileId),
      ),
    [entries, selectedModelId, selectedProfileId, selectedProviderInstanceId],
  );

  useEffect(() => {
    if (
      selectedProfile === undefined ||
      selectedProviderInstanceId === undefined ||
      selectedModelId === undefined
    ) {
      setStatus((current) =>
        current === "loading" || current === "error" || current === "unsupported"
          ? current
          : "ready",
      );
      setReceipt(undefined);
      return;
    }
    if (options.hostHealth !== undefined && options.hostHealth !== "healthy") {
      resolveSequence.current += 1;
      setReceipt(undefined);
      setStatus("unsupported");
      setMessage(
        `${options.hostLabel} is ${options.hostHealth}. Reconnect the host, then resolve this profile again.`,
      );
      return;
    }
    const sequence = ++resolveSequence.current;
    setStatus("resolving");
    setMessage(undefined);
    void options.client
      .resolveEffectiveProfile({
        mode: options.mode,
        hostId: options.hostId,
        projectExecutionPolicy: options.projectExecutionPolicy,
        scope: {
          scopeKind: options.scope.scopeKind,
          scopeRef: options.scope.scopeRef,
        },
        oneOffOverride: {
          profileId: selectedProfile.id,
          providerInstanceId: selectedProviderInstanceId,
          modelId: selectedModelId,
        },
      })
      .then((next) => {
        if (sequence !== resolveSequence.current) return;
        setReceipt(next);
        if (
          next.source === "none" ||
          next.profileId === undefined ||
          String(next.profileId) !== String(selectedProfile.id)
        ) {
          setStatus("unsupported");
          const reason =
            next.downgradeReasons[0]?.reason ?? "The selected execution profile is unsupported.";
          setMessage(
            `${reason} Choose another provider, model, or profile, or edit the profile constraints.`,
          );
          return;
        }
        setStatus("resolved");
      })
      .catch((error: unknown) => {
        if (sequence !== resolveSequence.current) return;
        setReceipt(undefined);
        setStatus("error");
        setMessage(actionableMessage(error, "The execution profile could not be resolved."));
      });
  }, [
    options.client,
    options.hostHealth,
    options.hostId,
    options.hostLabel,
    options.mode,
    options.projectExecutionPolicy,
    options.scope.scopeKind,
    options.scope.scopeRef,
    providerFactKey,
    selectedModelId,
    selectedProfile,
    selectedProviderInstanceId,
  ]);

  const selectProfile = useCallback(
    (profileId: AgentProfileId | undefined) => {
      setSelectedProfileId(profileId);
      setReceipt(undefined);
      setMessage(undefined);
      if (profileId === undefined) removeStoredProfile(storage, options.profileSelectionStorageKey);
      else storeProfile(storage, options.profileSelectionStorageKey, profileId);
    },
    [options.profileSelectionStorageKey, storage],
  );

  const selectEntry = useCallback(
    (entry: ExecutionContextPickerEntry) => {
      options.onSelectProvider({
        providerInstanceId: entry.providerInstanceId,
        modelId: entry.modelId,
      });
      selectProfile(entry.profileId);
    },
    [options, selectProfile],
  );

  const createProfile = useCallback(
    async (input: CreateExecutionProfileInput) => {
      setBusy(true);
      setMessage(undefined);
      try {
        const result = await options.client.execute({
          kind: "create-agent-profile",
          ...input,
        });
        if (result.kind !== "profile-created") {
          throw new Error(
            result.kind === "profile-command-failed"
              ? result.message
              : "Agent profile service returned an unexpected create result.",
          );
        }
        setProfiles((current) => [...current, result.profile]);
      } catch (error) {
        setMessage(actionableMessage(error, "The profile could not be created."));
        setStatus("error");
        throw error;
      } finally {
        setBusy(false);
      }
    },
    [options.client],
  );

  const updateProfile = useCallback(
    async (profile: AgentProfile) => {
      setBusy(true);
      setMessage(undefined);
      try {
        const result = await options.client.execute({
          kind: "update-agent-profile",
          profileId: profile.id,
          expectedVersion: profile.version,
          displayName: profile.displayName,
          ...(profile.description === undefined ? {} : { description: profile.description }),
          ...(profile.instructions === undefined ? {} : { instructions: profile.instructions }),
          approvedSkillIds: profile.approvedSkillIds,
          toolConstraints: profile.toolConstraints,
          modelConstraints: profile.modelConstraints,
          defaultExecutionPolicy: profile.defaultExecutionPolicy,
          defaultPermissionPersistence: profile.defaultPermissionPersistence,
          compatibleModes: profile.compatibleModes,
        });
        if (result.kind !== "profile-updated") {
          throw new Error(
            result.kind === "profile-command-failed"
              ? result.message
              : "Agent profile service returned an unexpected update result.",
          );
        }
        setProfiles((current) =>
          current.map((entry) =>
            String(entry.id) === String(result.profile.id) ? result.profile : entry,
          ),
        );
      } catch (error) {
        setMessage(actionableMessage(error, "The profile could not be updated."));
        setStatus("error");
        throw error;
      } finally {
        setBusy(false);
      }
    },
    [options.client],
  );

  const deleteProfile = useCallback(
    async (profile: AgentProfile) => {
      setBusy(true);
      setMessage(undefined);
      try {
        const result = await options.client.execute({
          kind: "remove-agent-profile",
          profileId: profile.id,
          expectedVersion: profile.version,
        });
        if (result.kind !== "profile-removed") {
          throw new Error(
            result.kind === "profile-command-failed"
              ? result.message
              : "Agent profile service returned an unexpected delete result.",
          );
        }
        setProfiles((current) =>
          current.filter((entry) => String(entry.id) !== String(result.profileId)),
        );
        if (String(selectedProfileId) === String(result.profileId)) selectProfile(undefined);
      } catch (error) {
        setMessage(actionableMessage(error, "The profile could not be deleted."));
        setStatus("error");
        throw error;
      } finally {
        setBusy(false);
      }
    },
    [options.client, selectProfile, selectedProfileId],
  );

  return {
    mode: options.mode,
    scope: options.scope,
    profiles,
    entries,
    selectedEntry,
    selectedProfile,
    receipt,
    status,
    busy,
    message,
    selectEntry,
    selectProfile,
    createProfile,
    updateProfile,
    deleteProfile,
    reload,
  };
}

function browserStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> | undefined {
  try {
    return typeof globalThis.localStorage === "undefined" ? undefined : globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function readStoredProfileId(
  storage: Pick<Storage, "getItem"> | undefined,
  key: string,
): AgentProfileId | undefined {
  try {
    const value = storage?.getItem(key);
    return value === null || value === undefined || value === ""
      ? undefined
      : (value as AgentProfileId);
  } catch {
    return undefined;
  }
}

function removeStoredProfile(storage: Pick<Storage, "removeItem"> | undefined, key: string): void {
  try {
    storage?.removeItem(key);
  } catch {
    // Selection persistence is a convenience; server resolution remains authoritative.
  }
}

function storeProfile(
  storage: Pick<Storage, "setItem"> | undefined,
  key: string,
  profileId: AgentProfileId,
): void {
  try {
    storage?.setItem(key, String(profileId));
  } catch {
    // Selection persistence is a convenience; server resolution remains authoritative.
  }
}

function actionableMessage(error: unknown, fallback: string): string {
  const detail = error instanceof Error && error.message.trim() !== "" ? error.message : fallback;
  return `${detail} Retry, or choose another provider, model, or profile.`;
}
