import type { OctantMode } from "@octant/contracts/modes";
import { useMemo, useState } from "react";
import type { RemoteSessionBridge } from "@octant/client-runtime";
import {
  buildRemoteHostObservation,
  canExecuteRemoteProductMutation,
  createRemoteDraftRegistry,
  exerciseRemoteChatMutation,
  exerciseRemoteChatSurface,
  exerciseRemoteCodeMutation,
  exerciseRemoteCodeSurface,
  exerciseRemoteWorkMutation,
  exerciseRemoteWorkSurface,
  exerciseRemoteProviderSurface,
  exerciseRemoteSettingsSurface,
  isRemoteProductMutationFailure,
  listRemoteShellSurfacesByAvailability,
  type RemoteShellSurfaceDescriptor,
} from "@octant/client-runtime";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { HostSelector } from "../shell/HostSelector";
import { ModeSwitcher } from "../shell/ModeSwitcher";
import { ShellState } from "../shell/ShellState";
import { RemoteDeviceSelfPanel } from "./RemoteDeviceSelfPanel";
import { RemoteProjectOverviewSection } from "./RemoteProjectOverviewSection";
import { useRemoteSession } from "./useRemoteSession";

export interface RemoteShellViewProps {
  readonly bridge: RemoteSessionBridge;
  readonly onReset: () => void;
  readonly onSignedOut?: () => void;
}

const modeDescriptions: Record<OctantMode, string> = {
  chat: "Conversation state over the authenticated remote session.",
  work: "Work thread inventory and mutations when the host connection is healthy.",
  code: "Code workspace state and mutations through the remote listener.",
};

type RemoteExercise = {
  readonly kind: "read" | "mutate";
  readonly label: string;
  readonly run: (bridge: RemoteSessionBridge) => Promise<{ ok: true }>;
};

const modeExercises: Record<
  OctantMode,
  { readonly read: RemoteExercise; readonly mutate: RemoteExercise }
> = {
  chat: {
    read: {
      kind: "read",
      label: "Read Chat bootstrap",
      run: (bridge) => exerciseRemoteChatSurface({ bridge }),
    },
    mutate: {
      kind: "mutate",
      label: "Verify Chat mutation",
      run: (bridge) => exerciseRemoteChatMutation({ bridge }),
    },
  },
  work: {
    read: {
      kind: "read",
      label: "Read Work threads",
      run: (bridge) => exerciseRemoteWorkSurface({ bridge }),
    },
    mutate: {
      kind: "mutate",
      label: "Verify Work mutation",
      run: (bridge) => exerciseRemoteWorkMutation({ bridge }),
    },
  },
  code: {
    read: {
      kind: "read",
      label: "Read Code bootstrap",
      run: (bridge) => exerciseRemoteCodeSurface({ bridge }),
    },
    mutate: {
      kind: "mutate",
      label: "Verify Code mutation",
      run: (bridge) => exerciseRemoteCodeMutation({ bridge }),
    },
  },
};

function modeExercise(
  mode: OctantMode,
  kind: "read" | "mutate",
  bridge: RemoteSessionBridge,
): Promise<{ ok: true }> {
  return modeExercises[mode][kind].run(bridge);
}

const auxiliaryExercises: ReadonlyArray<{
  readonly surface: RemoteShellSurfaceDescriptor;
  readonly buttonLabel?: string;
  readonly run?: (bridge: RemoteSessionBridge) => Promise<{ ok: true }>;
}> = [
  {
    surface: {
      id: "preview",
      label: "Previews",
      description: "Open an authorized preview from its Project or thread context.",
      availability: "remote",
      catalogAction: "preview.open-authorized",
    },
  },
  {
    surface: {
      id: "provider-models",
      label: "Provider models",
      description: "List configured provider models without reading credentials.",
      availability: "remote",
      catalogAction: "provider.list-models",
    },
    buttonLabel: "List provider models",
    run: (bridge) => exerciseRemoteProviderSurface({ bridge }),
  },
  {
    surface: {
      id: "settings-read",
      label: "Settings",
      description: "Read non-secret settings and tool configuration.",
      availability: "remote",
      catalogAction: "settings.read-non-secret",
    },
    buttonLabel: "Read settings",
    run: (bridge) => exerciseRemoteSettingsSurface({ bridge }),
  },
];

export function RemoteShellView(props: RemoteShellViewProps) {
  const state = useRemoteSession(props.bridge);
  const draftRegistry = useMemo(() => createRemoteDraftRegistry(), []);
  const hosts = buildRemoteHostObservation({ state });
  const [activeMode, setActiveMode] = useState<OctantMode>("chat");
  const [draft, setDraft] = useState(() => draftRegistry.read());
  const [mutationMessage, setMutationMessage] = useState<string>();
  const ready = canExecuteRemoteProductMutation(state);
  const localHostSurfaces = useMemo(
    () => listRemoteShellSurfacesByAvailability("local-host-only"),
    [],
  );

  const updateDraft = (value: string) => {
    setDraft(value);
    draftRegistry.write(value);
  };

  const runExercise = async (
    label: string,
    exercise: () => Promise<{ ok: true }>,
  ): Promise<void> => {
    setMutationMessage(undefined);
    try {
      await exercise();
      setMutationMessage(`${label} succeeded over the remote session.`);
    } catch (error) {
      if (isRemoteProductMutationFailure(error)) {
        setMutationMessage(error.message);
        return;
      }
      setMutationMessage(`${label} request failed.`);
    }
  };

  if (
    state.kind === "connecting" ||
    state.kind === "negotiating" ||
    state.kind === "authenticating"
  ) {
    return (
      <ShellState
        message="Establishing the authenticated remote session."
        state="loading"
        title="Connecting to Octant"
      />
    );
  }

  if (state.kind === "reconnecting") {
    return (
      <ShellState
        message="Your draft is preserved locally. Reconnecting does not queue authority offline."
        state="loading"
        title="Reconnecting"
      />
    );
  }

  if (state.kind === "incompatible") {
    return (
      <ShellState
        action={{ label: "Start over", onClick: props.onReset }}
        message={state.reason}
        role="alert"
        state="warning"
        title="Host incompatible"
      />
    );
  }

  if (state.kind === "unauthorized") {
    return (
      <ShellState
        action={{ label: "Start over", onClick: props.onReset }}
        message={state.reason}
        role="alert"
        state="disconnected"
        title="Remote access unauthorized"
      />
    );
  }

  if (state.kind === "unavailable") {
    return (
      <ShellState
        action={{ label: "Try reconnect", onClick: () => props.bridge.reconnect() }}
        message={state.reason}
        role="alert"
        state="disconnected"
        title="Host unavailable"
      />
    );
  }

  const activeExercises = modeExercises[activeMode];

  return (
    <section aria-label="Remote Octant shell" className="remote-shell" role="region">
      <header className="remote-shell__header">
        <h1 className="remote-shell__title">Octant remote session</h1>
        <HostSelector hosts={hosts} />
        <ModeSwitcher
          activeMode={activeMode}
          modes={["chat", "work", "code"]}
          onSelectMode={setActiveMode}
          presentation="buttons"
        />
      </header>

      {state.kind === "stale" ? (
        <ShellState
          action={{ label: "Reconnect", onClick: () => props.bridge.reconnect() }}
          message="The host connection is stale. Your composer draft remains on this device; reconnect to send changes."
          role="status"
          state="warning"
          title="Connection stale"
        />
      ) : null}

      <RemoteProjectOverviewSection bridge={props.bridge} mode={activeMode} />

      <RemoteDeviceSelfPanel
        bridge={props.bridge}
        onRevoked={props.onReset}
        onSignedOut={() => {
          if (props.onSignedOut !== undefined) {
            props.onSignedOut();
            return;
          }
          props.onReset();
        }}
      />

      <div className="remote-shell__composer">
        <label className="remote-shell__label" htmlFor="remote-draft">
          Composer draft
        </label>
        <OctantInput
          aria-describedby="remote-draft-hint"
          className="remote-shell__input"
          id="remote-draft"
          onChange={(event) => updateDraft(event.target.value)}
          placeholder="Draft text survives reconnect; it is never queued offline."
          value={draft}
        />
        <p className="remote-shell__hint" id="remote-draft-hint">
          Drafts stay on this browser across reconnect. Authority-bearing mutations fail closed
          while offline.
        </p>
      </div>

      <section aria-label={`${activeMode} remote surface`} className="remote-shell__mode-panel">
        <h2 className="remote-shell__surface-title">
          {activeMode === "chat" ? "Chat" : activeMode === "work" ? "Work" : "Code"}
        </h2>
        <p className="remote-shell__mode-description">{modeDescriptions[activeMode]}</p>
        <div className="remote-shell__mode-actions">
          <OctantButton
            disabled={!ready}
            onClick={() =>
              void runExercise(activeExercises.read.label, () =>
                modeExercise(activeMode, "read", props.bridge),
              )
            }
            type="button"
            variant="secondary"
          >
            {activeExercises.read.label}
          </OctantButton>
          <OctantButton
            disabled={!ready}
            onClick={() =>
              void runExercise(activeExercises.mutate.label, () =>
                modeExercise(activeMode, "mutate", props.bridge),
              )
            }
            type="button"
            variant="default"
          >
            {activeExercises.mutate.label}
          </OctantButton>
        </div>
      </section>

      <section aria-label="Remote tools and settings" className="remote-shell__surface-grid">
        <h2 className="remote-shell__section-title">Remote tools and settings</h2>
        {auxiliaryExercises.map((entry) => {
          const exercise =
            entry.run === undefined || entry.buttonLabel === undefined
              ? undefined
              : { label: entry.buttonLabel, run: entry.run };
          return (
            <article className="remote-shell__surface-card" key={entry.surface.id}>
              <h3 className="remote-shell__surface-title">{entry.surface.label}</h3>
              <p className="remote-shell__surface-description">{entry.surface.description}</p>
              {exercise === undefined ? (
                <span className="remote-shell__surface-badge badge">
                  Available in Project context
                </span>
              ) : (
                <OctantButton
                  disabled={!ready}
                  onClick={() => void runExercise(exercise.label, () => exercise.run(props.bridge))}
                  type="button"
                  variant="secondary"
                >
                  {exercise.label}
                </OctantButton>
              )}
            </article>
          );
        })}
      </section>

      <section
        aria-label="Local host only surfaces"
        className="remote-shell__surface-grid"
        role="note"
      >
        <h2 className="remote-shell__section-title">Local host only</h2>
        <p className="remote-shell__local-only">
          These surfaces require the packaged local host and stay hidden or disabled in remote
          browsers.
        </p>
        {localHostSurfaces.map((surface) => (
          <article
            aria-disabled="true"
            className="remote-shell__surface-card remote-shell__surface-card--local-only"
            key={surface.id}
          >
            <span className="remote-shell__surface-badge badge">Unavailable remotely</span>
            <h3 className="remote-shell__surface-title">{surface.label}</h3>
            <p className="remote-shell__surface-description">{surface.description}</p>
          </article>
        ))}
      </section>

      {mutationMessage === undefined ? null : (
        <p className="remote-shell__status" role="status" aria-live="polite">
          {mutationMessage}
        </p>
      )}

      <OctantButton onClick={props.onReset} type="button" variant="secondary">
        End remote session
      </OctantButton>
    </section>
  );
}
