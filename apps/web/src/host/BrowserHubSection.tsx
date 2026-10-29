import {
  createDefaultDeviceKeyStore,
  joinHubAsGuestAtOrigin,
  readAppPairingCode,
  type GuestJoinFinish,
  type GuestJoinRefusal,
  type GuestJoinStart,
  type OwnerSpoke,
  type RemoteDeviceKeyStore,
} from "@octant/client-runtime";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { REMOTE_WEB_BUILD_VERSION } from "../remote/useRemotePairing";
import {
  SettingRow,
  SettingsFactList,
  SettingsSection,
  SettingsState,
} from "../settings/primitives";
import type { HubAdministrationBridge } from "../shell/hostBridge";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantCheckbox } from "../ui/base/OctantCheckbox";
import { OctantField, OctantFieldLabel } from "../ui/base/OctantField";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantTextarea } from "../ui/base/OctantTextarea";
import { createBrowserHostRegistryStorage } from "./browserHostRegistryStorage";
import {
  browserOwnerSpokes,
  browserPageTransport,
  createBrowserGuestStore,
  type BrowserGuestState,
  type BrowserGuestStore,
} from "./browserHubGuest";
import { BrowserOwnerSection } from "./BrowserOwnerSection";
import { registerOwnerPasskey, type PasskeyCredentials } from "./ownerPasskey";

const POLL_MS = 3_000;

const JOIN_REFUSAL: Readonly<Record<GuestJoinRefusal, string>> = {
  "refused-code": "That code was refused.",
  "hub-declined": "The hub declined this browser.",
  "hub-refused-join": "The hub refused this browser.",
  "hub-answer-invalid": "The hub's answer did not check out, so nothing was saved.",
  "device-key-lost": "This browser lost the key it paired with. Try again.",
  "hub-unreachable": "Couldn't reach the hub. Check that you are on the same private network.",
};

const NO_PASSKEY_COPY =
  "This browser can't make a passkey here (it needs a secure page and a fingerprint, face, or device-passcode check), so it can join only as a plain guest.";

/** The browser's passkey API, or nothing when it has none: the owner option then stays off. */
async function platformPasskeys(): Promise<PasskeyCredentials | undefined> {
  const available = globalThis.PublicKeyCredential;
  if (available === undefined || globalThis.navigator?.credentials === undefined) return undefined;
  try {
    if (!(await available.isUserVerifyingPlatformAuthenticatorAvailable())) return undefined;
  } catch {
    return undefined;
  }
  return globalThis.navigator.credentials;
}

type Phase =
  | { readonly kind: "idle" }
  | { readonly kind: "working" }
  | {
      readonly kind: "comparing";
      readonly hubName: string;
      readonly comparisonCode: string;
      readonly finish: () => Promise<GuestJoinFinish>;
      readonly ownerPasskey?: BrowserGuestState["ownerPasskey"];
    }
  | { readonly kind: "failed"; readonly message: string };

export interface BrowserHubSectionProps {
  /** Present only in a desktop window, which administers its hub directly and gets no browser guest screen. */
  readonly hubAdministration: HubAdministrationBridge | undefined;
  /** Replace the browser's own pieces; only tests do. */
  readonly pageOrigin?: string;
  readonly deviceKeyStore?: RemoteDeviceKeyStore;
  readonly store?: BrowserGuestStore;
  readonly credentials?: PasskeyCredentials | null;
  readonly join?: typeof joinHubAsGuestAtOrigin;
  readonly pollMs?: number;
}

/**
 * Joins the hub that serves this page as a guest, from a remote browser: the
 * person pastes the hub's join code (an owner code too), compares the short
 * code with the one the hub shows, and approves there. With an owner code the
 * browser first makes a passkey for this origin and presents its public key, so
 * the person can later unlock owner actions with it. A browser that cannot make
 * a passkey does not join as an owner.
 */
export function BrowserHubSection(props: BrowserHubSectionProps) {
  const codeId = useId();
  const labelId = useId();
  const ownerId = useId();
  const pageOrigin = props.pageOrigin ?? globalThis.location.origin;
  const deviceKeyStore = useMemo(
    () => props.deviceKeyStore ?? createDefaultDeviceKeyStore(),
    [props.deviceKeyStore],
  );
  const store = useMemo(
    () => props.store ?? createBrowserGuestStore(createBrowserHostRegistryStorage()),
    [props.store],
  );
  const [passkeys, setPasskeys] = useState<PasskeyCredentials | undefined>();
  const [state, setState] = useState<BrowserGuestState | undefined>();
  const [spokes, setSpokes] = useState<ReadonlyArray<OwnerSpoke>>([]);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [code, setCode] = useState("");
  const [deviceLabel, setDeviceLabel] = useState("Octant browser");
  const [asOwner, setAsOwner] = useState(false);

  useEffect(() => {
    if (props.credentials !== undefined) {
      setPasskeys(props.credentials ?? undefined);
      return;
    }
    let live = true;
    void platformPasskeys().then((found) => {
      if (live) setPasskeys(found);
    });
    return () => {
      live = false;
    };
  }, [props.credentials]);

  useEffect(() => {
    let live = true;
    void store.load().then((held) => {
      if (live) setState(held);
    });
    return () => {
      live = false;
    };
  }, [store]);

  useEffect(() => {
    if (state === undefined || passkeys === undefined) {
      setSpokes([]);
      return;
    }
    let live = true;
    void browserOwnerSpokes({ state, deviceKeyStore, credentials: passkeys, pageOrigin }).then(
      (owned) => {
        if (live) setSpokes(owned);
      },
      () => {
        if (live) setSpokes([]);
      },
    );
    return () => {
      live = false;
    };
  }, [state, passkeys, deviceKeyStore, pageOrigin]);

  const begin = async () => {
    const reading = readAppPairingCode(code.trim());
    if (reading.status === "refused") {
      setPhase({
        kind: "failed",
        message:
          reading.reason === "not-a-pairing-code"
            ? "This isn't an Octant join code."
            : reading.message,
      });
      return;
    }
    setPhase({ kind: "working" });
    try {
      let ownerPasskey: BrowserGuestState["ownerPasskey"];
      if (asOwner) {
        if (passkeys === undefined) {
          setPhase({ kind: "failed", message: NO_PASSKEY_COPY });
          return;
        }
        // The hub records the unlock key only at join, before this browser has a
        // member id, so the passkey's user handle is a fresh one.
        const made = await registerOwnerPasskey({
          credentials: passkeys,
          hostName: new URL(pageOrigin).hostname,
          ownerMemberId: crypto.randomUUID(),
          ownerName: deviceLabel.trim() || "Octant browser",
        });
        if (made.status !== "registered") {
          setPhase({
            kind: "failed",
            message: "No passkey was made, so nothing was sent to the hub.",
          });
          return;
        }
        ownerPasskey = made.passkey;
      }
      const started: GuestJoinStart = await (props.join ?? joinHubAsGuestAtOrigin)({
        origin: pageOrigin,
        ticket: reading.ticket,
        deviceLabel: deviceLabel.trim() || "Octant browser",
        transport: browserPageTransport(pageOrigin),
        webBuildVersion: REMOTE_WEB_BUILD_VERSION,
        deviceKeyStore,
        ...(ownerPasskey === undefined ? {} : { ownerUnlockPublicKey: ownerPasskey.publicKey }),
      });
      if (started.status !== "awaiting-approval") {
        setPhase({ kind: "failed", message: started.message });
        return;
      }
      setPhase({
        kind: "comparing",
        hubName: started.hubName,
        comparisonCode: started.comparisonCode,
        finish: started.finish,
        ...(ownerPasskey === undefined ? {} : { ownerPasskey }),
      });
    } catch {
      setPhase({ kind: "failed", message: "Couldn't reach the hub." });
    }
  };

  const check = useCallback(
    async (current: Extract<Phase, { kind: "comparing" }>) => {
      try {
        const finished = await current.finish();
        if (finished.status === "awaiting-approval") {
          setPhase({ ...current });
          return;
        }
        if (finished.status === "refused") {
          setPhase({ kind: "failed", message: JOIN_REFUSAL[finished.kind] });
          return;
        }
        const joined: BrowserGuestState = {
          record: finished.record,
          deviceLabel: deviceLabel.trim() || "Octant browser",
          ...(current.ownerPasskey === undefined ? {} : { ownerPasskey: current.ownerPasskey }),
        };
        await store.save(joined);
        setState(joined);
        setCode("");
        setPhase({ kind: "idle" });
      } catch {
        setPhase({ ...current });
      }
    },
    [deviceLabel, store],
  );

  // Each check that finds the hub still waiting replaces the phase, which re-arms this timer.
  useEffect(() => {
    if (phase.kind !== "comparing") return;
    const timer = setTimeout(() => void check(phase), props.pollMs ?? POLL_MS);
    return () => clearTimeout(timer);
  }, [phase, check, props.pollMs]);

  if (props.hubAdministration !== undefined) return null;

  const leave = async () => {
    if (state === undefined) return;
    await deviceKeyStore.remove(state.record.deviceKeyId).catch(() => undefined);
    await store.clear();
    setState(undefined);
    setSpokes([]);
  };

  return (
    <>
      <SettingsSection title="Hub">
        {state === undefined ? (
          <div className="setgroup">
            <SettingRow
              description="On the hub, make a join code in Settings → Remote access or with octant hub join-code (add --owner for an owner code), then paste the whole code here."
              label="Join the hub as a guest"
              scope="app"
              settingId="browser-hub-code"
            >
              <div className="settings-panel__stack">
                <OctantField>
                  <OctantFieldLabel htmlFor={codeId}>Hub join code</OctantFieldLabel>
                  <OctantTextarea
                    autoComplete="off"
                    id={codeId}
                    onChange={(event) => setCode(event.target.value)}
                    placeholder="octant-pair-1.…"
                    rows={3}
                    spellCheck={false}
                    value={code}
                  />
                </OctantField>
                <OctantField>
                  <OctantFieldLabel htmlFor={labelId}>Name for this browser</OctantFieldLabel>
                  <OctantInput
                    id={labelId}
                    onChange={(event) => setDeviceLabel(event.target.value)}
                    value={deviceLabel}
                  />
                </OctantField>
                <label className="check">
                  <OctantCheckbox
                    checked={asOwner && passkeys !== undefined}
                    disabled={passkeys === undefined}
                    id={ownerId}
                    onChange={(event) => setAsOwner(event.target.checked)}
                  />
                  <span>
                    This is an owner code. This browser makes a passkey for this address and unlocks
                    owner actions with it.
                  </span>
                </label>
                {passkeys === undefined ? (
                  <SettingsState kind="empty">{NO_PASSKEY_COPY}</SettingsState>
                ) : null}
                <div className="host-settings__controls">
                  <OctantButton
                    disabled={
                      phase.kind === "working" ||
                      phase.kind === "comparing" ||
                      code.trim().length === 0
                    }
                    onClick={() => void begin()}
                    size="sm"
                    type="button"
                    variant="secondary"
                  >
                    Join the hub
                  </OctantButton>
                </div>
              </div>
            </SettingRow>
            {phase.kind === "comparing" ? (
              <SettingRow
                description="Compare the code below with the one the hub shows, then approve there."
                label={`Joining ${phase.hubName}`}
                scope="app"
                settingId="browser-hub-claim"
              >
                <div className="settings-panel__stack">
                  <SettingsFactList
                    facts={[
                      {
                        label: "Comparison code",
                        value: <span className="oct-meta--mono">{phase.comparisonCode}</span>,
                      },
                    ]}
                  />
                  <SettingsState kind="loading">
                    Waiting for {phase.hubName}. Approve there only if it shows the same code.
                  </SettingsState>
                </div>
              </SettingRow>
            ) : null}
            {phase.kind === "failed" ? (
              <SettingsState kind="error">{phase.message}</SettingsState>
            ) : null}
          </div>
        ) : (
          <div className="setgroup">
            <SettingRow
              description={
                state.ownerPasskey === undefined
                  ? "Joined as a guest. Each computer on the hub decides what this browser may do there."
                  : "Joined as an owner device. Owner actions ask for your passkey."
              }
              label={`Joined ${state.record.hub.name}`}
              scope="app"
              settingId="browser-hub-joined"
            >
              <div className="host-settings__controls">
                <OctantButton
                  onClick={() => void leave()}
                  size="sm"
                  type="button"
                  variant="secondary"
                >
                  Leave the hub
                </OctantButton>
              </div>
            </SettingRow>
            <SettingsState kind="empty">
              Remove this browser on the hub too, so the hub stops listing it.
            </SettingsState>
          </div>
        )}
      </SettingsSection>
      <BrowserOwnerSection
        credentials={passkeys}
        hubAdministration={props.hubAdministration}
        spokes={spokes}
      />
    </>
  );
}
