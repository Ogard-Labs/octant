import type { NavigatorAssistantSnapshot, SettingsDeepLink } from "@octant/contracts";
import { useState, type ReactNode } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import type {
  NavigatorAssistantController,
  NavigatorAssistantState,
} from "./useNavigatorAssistant";

export interface NavigatorPanelProps {
  /**
   * The shared Navigator reader. Both fronts are handed the same controller,
   * so a turn sent from either is on screen in both without a re-read.
   */
  readonly controller: NavigatorAssistantController;
  /** Deep-links into Settings. Navigator proposes the fix; the user applies it. */
  readonly onOpenSettings: (target: SettingsDeepLink) => void;
  readonly onClose?: () => void;
  /**
   * Surface-specific content rendered above the conversation — Zen's inert
   * recipe preview and its tool-capability notice. It is passed in rather than
   * known here so the panel stays the shared conversation, not a switch over
   * which front is showing it.
   */
  readonly children?: ReactNode;
}

/**
 * The Navigator surface.
 *
 * Navigator is host-owned: readiness, the bound conversation, and the model
 * every turn runs on all come from the host's snapshot, and this panel renders
 * exactly what it was told. Configuring a default model in Settings is what
 * moves this conversation onto that model, because the send below is the same
 * host command that pins it.
 *
 * The panel has no mutation authority. Its only command is `send-message`;
 * every fix it offers is a deep link into Settings that the user applies.
 */
export function NavigatorPanel(props: NavigatorPanelProps) {
  const navigator = props.controller;
  const [prompt, setPrompt] = useState("");
  const state = navigator.state;

  return (
    <section aria-label="Navigator" className="navigator-panel">
      <header className="navigator-panel__header">
        <div>
          <h2>Navigator</h2>
          <p>{describe(state)}</p>
        </div>
        {props.onClose === undefined ? null : (
          <OctantButton onClick={props.onClose} type="button" variant="ghost">
            Close
          </OctantButton>
        )}
      </header>

      {props.children}

      {state.kind === "unsupported" ? (
        <p className="navigator-panel__notice" role="status">
          Navigator is not available on this host.
        </p>
      ) : null}

      {state.kind === "loading" ? (
        <p className="navigator-panel__notice" role="status">
          Loading Navigator…
        </p>
      ) : null}

      {state.kind === "unconfigured" ? (
        <div className="navigator-panel__notice" role="status">
          <strong>Navigator has no default model</strong>
          <p>
            Choose the provider and model Navigator runs on. Until then it will not answer — it
            never falls back to another configured model.
          </p>
          {state.settingsTarget === undefined ? null : (
            <OctantButton
              onClick={() => props.onOpenSettings(navigatorSettingsTarget(state.settingsTarget))}
              type="button"
              variant="secondary"
            >
              Open Navigator settings
            </OctantButton>
          )}
        </div>
      ) : null}

      {state.kind === "unavailable" ? (
        <div className="navigator-panel__notice" role="alert">
          <strong>Navigator is unavailable</strong>
          <p>{state.reason}</p>
          <OctantButton onClick={() => void navigator.refresh()} type="button" variant="secondary">
            Try again
          </OctantButton>
          {state.settingsTarget === undefined ? null : (
            <OctantButton
              onClick={() => props.onOpenSettings(navigatorSettingsTarget(state.settingsTarget))}
              type="button"
              variant="secondary"
            >
              Open Navigator settings
            </OctantButton>
          )}
        </div>
      ) : null}

      {state.kind === "ready" ? (
        <ReadyNavigator
          busy={navigator.busy}
          onOpenSettings={props.onOpenSettings}
          onRefresh={() => void navigator.refresh()}
          snapshot={state.snapshot}
        />
      ) : null}

      {state.kind === "ready" || state.kind === "unconfigured" ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const next = prompt.trim();
            if (next.length === 0 || navigator.busy) return;
            setPrompt("");
            void navigator.send(next);
          }}
        >
          <OctantInput
            aria-label="Message Navigator"
            disabled={state.kind === "unconfigured"}
            onChange={(event) => setPrompt(event.currentTarget.value)}
            placeholder="Ask Navigator…"
            type="text"
            value={prompt}
          />
          <OctantButton
            disabled={navigator.busy || state.kind === "unconfigured"}
            type="submit"
            variant="default"
          >
            Send to Navigator
          </OctantButton>
        </form>
      ) : null}
    </section>
  );
}

function ReadyNavigator(props: {
  readonly busy: boolean;
  readonly onOpenSettings: (target: SettingsDeepLink) => void;
  readonly onRefresh: () => void;
  readonly snapshot: NavigatorAssistantSnapshot;
}) {
  const { snapshot } = props;
  // `unknown` is not `supported`: a model the host has not observed to read
  // images is reported as unable to, and a configured reviewer is named as the
  // thing that would cover it. Routing an image is slice 5; saying so honestly
  // is this surface's job now.
  const imagesUnsupported = snapshot.imageInput !== "supported";

  return (
    <>
      {imagesUnsupported ? (
        <div className="navigator-panel__capability" role="status">
          <strong>Images unavailable</strong>
          <p>
            {snapshot.visionReviewer === null
              ? "The Navigator model is not known to read images, and no vision reviewer is configured."
              : "The Navigator model is not known to read images; the configured vision reviewer covers them."}
          </p>
          <OctantButton
            onClick={() => props.onOpenSettings(navigatorSettingsTarget(snapshot.settingsTarget))}
            type="button"
            variant="secondary"
          >
            Open Navigator settings
          </OctantButton>
        </div>
      ) : null}

      <div aria-label="Navigator transcript" className="navigator-panel__transcript" role="log">
        {snapshot.transcript.length === 0 ? (
          <p className="navigator-panel__empty">No messages yet. Ask Navigator anything.</p>
        ) : (
          snapshot.transcript.map((message, index) => (
            <p
              className={`navigator-panel__message navigator-panel__message--${message.role}`}
              key={`${message.createdAt}-${index}`}
            >
              <strong>{message.role === "user" ? "You" : "Navigator"}</strong>
              <span>{message.text}</span>
            </p>
          ))
        )}
      </div>

      <OctantButton
        disabled={props.busy}
        onClick={props.onRefresh}
        size="sm"
        type="button"
        variant="ghost"
      >
        Refresh conversation
      </OctantButton>
    </>
  );
}

function describe(state: NavigatorAssistantState): string {
  switch (state.kind) {
    case "loading":
      return "Reading Navigator readiness…";
    case "unsupported":
      return "Not available on this host";
    case "unconfigured":
      return "No default model configured";
    case "unavailable":
      return "Unavailable";
    case "ready":
      return state.snapshot.defaultProvider === null
        ? "Ready"
        : `Running on ${String(state.snapshot.defaultProvider.modelId)}`;
  }
}

/** The host names the destination; an absent one still lands on the section. */
function navigatorSettingsTarget(target: SettingsDeepLink | undefined): SettingsDeepLink {
  return target ?? ({ section: "navigator-assistant" } as SettingsDeepLink);
}
