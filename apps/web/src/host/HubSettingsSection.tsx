import { HUB_GRANT_ITEMS, type HubGrantItem } from "@octant/contracts";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { failureMessage } from "../lib/failureMessage";
import {
  SettingRow,
  SettingsFactList,
  SettingsSection,
  SettingsState,
} from "../settings/primitives";
import type {
  HubAdministrationBridge,
  HubAdministrationOperation,
  RemoteAccessAdministrationBridge,
  RemotePendingPairingRequest,
} from "../shell/hostBridge";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantCheckbox } from "../ui/base/OctantCheckbox";
import { OctantConfirmDialog } from "../ui/base/OctantConfirmDialog";
import { OctantField, OctantFieldLabel } from "../ui/base/OctantField";
import { OctantSwitch } from "../ui/base/OctantSwitch";
import { OctantTextarea } from "../ui/base/OctantTextarea";
import {
  NewMemberChecks,
  OwnerDevices,
  type HeldMemberRow,
  type NewMemberAlertRow,
  type OwnerCandidateRow,
  type OwnerKeyMismatchRow,
  type OwnerRow,
} from "./HubOwnerPanels";
import { PairingCodeQr } from "./PairingCodeQr";

/**
 * The hub role and hub membership of this host. Every action goes through the
 * loopback hub administration, which only a local window has, so the parent
 * mounts this section only when that bridge exists and a remote client never
 * sees it. Nothing here changes until the person acts.
 */
export interface HubSettingsSectionProps {
  readonly hub: HubAdministrationBridge;
  /** The pairing requests a joining device raises on the hub are approved here, as for any pairing. */
  readonly pairing: Pick<
    RemoteAccessAdministrationBridge,
    "listRemotePairingRequests" | "approveRemotePairingRequest" | "denyRemotePairingRequest"
  >;
  /** Reads the clock so a test can freeze a code's time left. */
  readonly now?: () => number;
}

const GRANT_ITEM_COPY: Readonly<Record<HubGrantItem, { label: string; line: string }>> = {
  roster: { label: "Roster", line: "The hub's signed list of members." },
  status: {
    label: "Status",
    line: "Read this computer's resources, thread titles and states, waiting approvals, and update status.",
  },
  introduce: {
    label: "Introduce",
    line: "Introduce other members to this computer; each becomes a full member here.",
  },
  wake: { label: "Wake", line: "Hold this computer's routine wake times and wake it." },
  owners: {
    label: "Owners",
    line: "Let your owner devices act here with a window's powers after a fresh unlock.",
  },
  standby: {
    label: "Standby",
    line: "Let a standby hub you named use this grant while it stands in for the hub.",
  },
  push: {
    label: "Push",
    line: "Send this computer's sealed phone notifications through the hub.",
  },
  provision: {
    label: "Provision",
    line: "Offer settings as proposals that you apply here.",
  },
  act: {
    label: "Act",
    line: "Act here as a paired device would, in the Projects you name. Approvals stay here.",
  },
};

const REFUSAL_COPY: Readonly<Record<string, string>> = {
  "hub-role-off": "The hub role is off.",
  "listener-not-running":
    "The remote listener is not running. Turn it on first under Remote listener.",
  "listener-not-private":
    "The remote listener is not on a private network address, so the hub will not use it.",
  "listener-has-no-pin":
    "The remote listener serves a certificate Octant cannot pin, so a join code cannot name it.",
  "pairing-unavailable": "Pairing is not available on this host right now.",
  "not-a-join-code": "That is not a join code.",
  "damaged-join-code": "That join code is damaged. Copy it again.",
  "newer-join-code": "That join code is from a newer Octant. Update this app first.",
  "hub-origin-not-private": "The hub's address is not on a private network.",
  "hub-identity-unproven": "The hub did not prove who it is, so nothing was saved.",
  "hub-too-old": "That hub is too old to join. Update it first.",
  "identity-mismatch": "The hub does not match the code.",
  "already-joined": "This computer already belongs to a hub. Leave it first.",
  "hub-unreachable":
    "Octant could not reach the hub. Check that both computers are on the same private network.",
  "no-join-in-progress": "No join is in progress. Paste a new code.",
  "hub-declined": "The hub declined this computer.",
  "hub-refused-join": "The hub refused this computer.",
  "hub-answer-invalid": "The hub's answer did not check out, so nothing was saved.",
  "not-a-member": "That is not a member of this hub.",
  "cannot-remove-the-hub": "The hub cannot remove itself.",
  "not-a-spoke": "This computer has not joined a hub.",
  "hub-revoked": "The hub removed this computer.",
  "acknowledgement-required": "Read the certificate-transparency note and tick it first.",
  "not-a-tailnet-name": "The remote listener is not served at a Tailscale name (*.ts.net).",
  "turned-off": "The Tailscale certificate is off.",
  "daemon-not-reachable":
    "Octant could not reach Tailscale. Check that it is installed and signed in.",
  "https-not-enabled":
    "HTTPS certificates are not turned on for this tailnet in the Tailscale admin console.",
  "name-not-served": "Tailscale does not serve a certificate for this computer's name.",
  "invalid-certificate":
    "The certificate Tailscale sent did not check out (bad key, expired, wrong name, or unreadable), so nothing was installed.",
  "could-not-apply":
    "The remote listener could not restart with that certificate, so it was dropped and the listener is using its own again.",
  "not-in-roster": "That device is not on the roster this computer holds.",
  "cannot-own-the-hub": "The hub cannot be an owner.",
  "cannot-own-itself": "A computer cannot list itself as an owner.",
  "unlock-key-invalid": "That is not a valid unlock key, so nothing was added.",
  "no-unlock-key-listed":
    "The roster lists no unlock key for that device. Join the hub again with an owner code.",
  "unlock-key-mismatch":
    "The roster lists a different unlock key for that device, so nothing was added.",
  "already-owner": "That device is already an owner here.",
  "not-an-owner": "That device is not an owner here.",
  "not-awaiting-confirmation": "That member is not waiting for confirmation.",
  "confirmation-invalid": "That confirmation did not check out, so the member stays as it was.",
  "no-such-alert": "That alert is already gone.",
  "could-not-remove":
    "The remote listener could not restart without the Tailscale certificate, so it is still on. Try turning it off again.",
};

interface Reply {
  readonly status: number;
  readonly body: unknown;
}

interface Member {
  readonly memberId: string;
  readonly name: string;
  readonly role: string;
  readonly owner: boolean;
  readonly identityKeyFingerprint: string;
}

interface Grant {
  readonly items: ReadonlyArray<HubGrantItem>;
  readonly actProjects: ReadonlyArray<string>;
}

interface HubStatus {
  readonly enabled: boolean;
  readonly members: ReadonlyArray<Member>;
  /** The hub's own owner list, and the roster members that list an unlock key but are not on it. */
  readonly owners: ReadonlyArray<OwnerRow>;
  readonly ownerCandidates: ReadonlyArray<OwnerCandidateRow>;
  readonly link?: {
    readonly membership: "member" | "removed";
    readonly hubName: string;
    readonly grant: Grant;
    /** The hub's roster as this computer holds it, each with whether this computer accepted it. */
    readonly roster: ReadonlyArray<Member & { readonly accepted: boolean }>;
    /** This computer's own owner list, the roster entries to confirm or that changed, Confirm new members, the members it holds for it, and its alerts. */
    readonly owners: ReadonlyArray<OwnerRow>;
    readonly ownerCandidates: ReadonlyArray<OwnerCandidateRow>;
    readonly ownerKeyMismatches: ReadonlyArray<OwnerKeyMismatchRow>;
    readonly confirmNewMembers: boolean;
    readonly heldMembers: ReadonlyArray<HeldMemberRow>;
    readonly alerts: ReadonlyArray<NewMemberAlertRow>;
  };
}

interface CertificateStatus {
  readonly enabled: boolean;
  readonly domain?: string;
  readonly renewal?: "current" | "due" | "expired";
}

type StatusState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly status: HubStatus };

type JoinState =
  | { readonly phase: "idle" }
  | {
      readonly phase: "comparing";
      readonly hubName: string;
      readonly fingerprint: string;
      readonly comparisonCode: string;
    }
  | { readonly phase: "grant"; readonly hubName: string; readonly grant: Grant };

interface MintedJoinCode {
  readonly code: string;
  /** Epoch milliseconds. */
  readonly expiresAt: number;
  readonly owner: boolean;
}

/** How often a joining computer asks the hub whether it approved. */
const JOIN_POLL_MS = 2_000;
/** How often the hub re-reads its pairing requests while a code is live. */
const PENDING_POLL_MS = 3_000;

export function HubSettingsSection({ hub, pairing, now }: HubSettingsSectionProps) {
  const clock = now ?? (() => Date.now());
  const clockRef = useRef(clock);
  clockRef.current = clock;
  const [state, setState] = useState<StatusState>({ kind: "loading" });
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [owner, setOwner] = useState(false);
  const [minted, setMinted] = useState<MintedJoinCode>();
  const [codeExpired, setCodeExpired] = useState(false);
  const [, setTick] = useState(0);
  const [pending, setPending] = useState<ReadonlyArray<RemotePendingPairingRequest>>([]);
  const [removing, setRemoving] = useState<Member>();
  const [leaving, setLeaving] = useState(false);
  const [certificate, setCertificate] = useState<CertificateStatus>();
  const [transparencyRead, setTransparencyRead] = useState(false);
  const transparencyId = useId();
  const [joinCode, setJoinCode] = useState("");
  const [join, setJoin] = useState<JoinState>({ phase: "idle" });
  const [draft, setDraft] = useState<ReadonlyArray<HubGrantItem>>([]);
  const ownerId = useId();
  const codeId = useId();
  const removeOpener = useRef<HTMLButtonElement>(null);
  const leaveOpener = useRef<HTMLButtonElement>(null);

  const request = useCallback(
    async (operation: HubAdministrationOperation, body?: unknown): Promise<Reply> =>
      body === undefined
        ? await hub.hubAdministrationRequest(operation)
        : await hub.hubAdministrationRequest(operation, body),
    [hub],
  );

  const refresh = useCallback(async () => {
    try {
      const reply = await request("status");
      const status = reply.status === 200 ? readStatus(reply.body) : undefined;
      setState(
        status === undefined
          ? { kind: "error", message: "Octant could not read the hub status." }
          : { kind: "ready", status },
      );
    } catch (error) {
      setState({
        kind: "error",
        message: failureMessage(error, "Octant could not read the hub status."),
      });
    }
  }, [request]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const refreshCertificate = useCallback(async () => {
    try {
      const reply = await request("certificate-status");
      setCertificate(reply.status === 200 ? readCertificate(reply.body) : undefined);
    } catch {
      setCertificate(undefined);
    }
  }, [request]);

  useEffect(() => {
    void refreshCertificate();
  }, [refreshCertificate]);

  const setTailscaleCertificate = async (on: boolean) => {
    if (on) {
      const enabled = await act(
        "certificate",
        { action: "enable", acknowledgedCertificateTransparency: transparencyRead },
        "enabled",
        "Octant could not turn on the Tailscale certificate.",
      );
      // Turning it on only records the choice; asking now shows whether this
      // computer can get a certificate, and why not.
      if (enabled !== undefined) {
        await act(
          "certificate",
          { action: "renew" },
          "renewed",
          "Octant could not get the Tailscale certificate.",
        );
      }
    } else {
      await act(
        "certificate",
        { action: "disable" },
        "disabled",
        "Octant could not turn off the Tailscale certificate.",
      );
      setTransparencyRead(false);
    }
    await refreshCertificate();
  };

  const status = state.kind === "ready" ? state.status : undefined;
  const hubOn = status?.enabled === true;

  // Run an act and say plainly why the server refused it.
  const act = async (
    operation: HubAdministrationOperation,
    body: unknown,
    expected: string,
    failure: string,
    refusals: Readonly<Record<string, string>> = {},
  ): Promise<Reply | undefined> => {
    setMessage(undefined);
    setBusy(true);
    try {
      const reply = await request(operation, body);
      if (reply.status === 200 && field(reply.body, "status") === expected) return reply;
      const kind = field(reply.body, "kind");
      setMessage(
        typeof kind === "string" && refusals[kind] !== undefined
          ? refusals[kind]
          : refusalText(reply, failure),
      );
    } catch (error) {
      setMessage(failureMessage(error, failure));
    } finally {
      setBusy(false);
    }
    return undefined;
  };

  const setHubRole = async (on: boolean) => {
    const reply = await act(
      on ? "enable" : "disable",
      undefined,
      on ? "enabled" : "disabled",
      on ? "Octant could not turn on the hub role." : "Octant could not turn off the hub role.",
    );
    if (reply !== undefined && !on) {
      setMinted(undefined);
      setPending([]);
    }
    await refresh();
  };

  const mintCode = async () => {
    setCodeExpired(false);
    const reply = await act("join-code", { owner }, "minted", "Octant could not make a join code.");
    const code = field(reply?.body, "code");
    const expiresAt = field(reply?.body, "expiresAt");
    if (typeof code === "string" && typeof expiresAt === "number") {
      setMinted({ code, expiresAt, owner });
    }
  };

  const removeMember = async (member: Member) => {
    setRemoving(undefined);
    const reply = await act(
      "remove",
      { memberId: member.memberId },
      "removed",
      "Octant could not remove that member.",
    );
    if (reply !== undefined) setMessage(`Removed ${member.name}.`);
    await refresh();
  };

  const startJoin = async () => {
    const reply = await act(
      "join",
      { code: joinCode.trim() },
      "awaiting-approval",
      "Octant could not start joining that hub.",
    );
    const hubName = field(reply?.body, "hubName");
    const fingerprint = field(reply?.body, "hubKeyFingerprint");
    const comparisonCode = field(reply?.body, "comparisonCode");
    if (
      typeof hubName === "string" &&
      typeof fingerprint === "string" &&
      typeof comparisonCode === "string"
    ) {
      setJoin({ phase: "comparing", hubName, fingerprint, comparisonCode });
    }
  };

  const leave = async () => {
    setLeaving(false);
    const reply = await act("leave", undefined, "left", "Octant could not leave the hub.");
    if (reply !== undefined) {
      setJoin({ phase: "idle" });
      setJoinCode("");
      setMessage(
        field(reply.body, "hubNotified") === true
          ? "Left the hub. The hub was told and drops this computer from its roster."
          : "Left the hub. The hub could not be reached, so remove this computer from its roster on the hub.",
      );
    }
    await refresh();
  };

  const saveGrant = async (items: ReadonlyArray<HubGrantItem>, current: Grant) => {
    const reply = await act(
      "grant",
      // Projects may be named only while Act is ticked.
      { items, actProjects: items.includes("act") ? current.actProjects : [] },
      "changed",
      "Octant could not change the hub grant.",
    );
    if (reply !== undefined) {
      setJoin({ phase: "idle" });
      setMessage("The hub grant is saved.");
    }
    await refresh();
  };

  const addOwner = async (candidate: OwnerCandidateRow) => {
    const reply = await act(
      "owners-add",
      {
        owners: [
          {
            memberId: candidate.memberId,
            identityKeyFingerprint: candidate.identityKeyFingerprint,
            unlockKeyFingerprint: candidate.unlockKeyFingerprint,
          },
        ],
      },
      "changed",
      "Octant could not add that owner.",
      {
        "identity-mismatch":
          "The roster lists a different device key for that member, so nothing was added.",
      },
    );
    if (reply !== undefined) setMessage(`Added ${candidate.name} as an owner.`);
    await refresh();
  };

  const removeOwner = async (owner: OwnerRow) => {
    const reply = await act(
      "owners-remove",
      { memberId: owner.memberId },
      "changed",
      "Octant could not remove that owner.",
    );
    if (reply !== undefined) setMessage(`Removed ${owner.name} as an owner.`);
    await refresh();
  };

  const setConfirmNewMembers = async (enabled: boolean) => {
    const reply = await act(
      "confirm-new-members",
      { enabled },
      "changed",
      "Octant could not change Confirm new members.",
    );
    if (reply !== undefined) setMessage(`Confirm new members is ${enabled ? "on" : "off"}.`);
    await refresh();
  };

  const confirmMember = async (memberId: string, name: string) => {
    const reply = await act(
      "confirm-member",
      { memberId },
      "confirmed",
      "Octant could not confirm that member.",
    );
    if (reply !== undefined) setMessage(`Confirmed ${name}.`);
    await refresh();
  };

  const settleAlert = async (alert: NewMemberAlertRow, how: "dismiss" | "remove") => {
    const reply = await act(
      how === "dismiss" ? "alert-dismiss" : "alert-remove",
      { alertId: alert.alertId },
      how === "dismiss" ? "dismissed" : "removed",
      "Octant could not settle that alert.",
    );
    if (reply !== undefined) {
      setMessage(
        how === "dismiss"
          ? `Dismissed the alert about ${alert.name}.`
          : `Removed ${alert.name} from this computer. Check the hub too.`,
      );
    }
    await refresh();
  };

  const decide = async (item: RemotePendingPairingRequest, decision: "approve" | "deny") => {
    setMessage(undefined);
    try {
      if (decision === "approve") {
        await pairing.approveRemotePairingRequest(item.ticketId);
        setMessage(`Approved ${item.deviceLabel}.`);
      } else {
        await pairing.denyRemotePairingRequest(item.ticketId, "user-denied");
        setMessage(`Denied ${item.deviceLabel}.`);
      }
    } catch (error) {
      setMessage(failureMessage(error, "The decision was not applied."));
    }
    setPending(await pairing.listRemotePairingRequests().catch(() => []));
    await refresh();
  };

  // A joining computer asks the hub whether it approved until the hub answers.
  useEffect(() => {
    if (join.phase !== "comparing") return;
    let cancelled = false;
    const ask = async () => {
      try {
        const reply = await request("join-finish");
        if (cancelled) return;
        const answer = field(reply.body, "status");
        if (reply.status === 200 && answer === "joined") {
          const grant = readGrant(field(reply.body, "grant"));
          if (grant !== undefined) {
            setDraft(grant.items);
            setJoin({ phase: "grant", hubName: join.hubName, grant });
            return;
          }
          setMessage("Octant returned an unusable hub grant.");
        } else if (reply.status === 200 && answer === "awaiting-approval") {
          timer = setTimeout(() => void ask(), JOIN_POLL_MS);
          return;
        } else {
          setMessage(refusalText(reply, "Joining the hub failed."));
        }
      } catch (error) {
        if (!cancelled) setMessage(failureMessage(error, "Joining the hub failed."));
      }
      setJoin({ phase: "idle" });
    };
    let timer = setTimeout(() => void ask(), 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [join, request]);

  // A joined computer keeps editing the grant it already has.
  const linked = status?.link;
  useEffect(() => {
    if (linked !== undefined && join.phase === "idle") setDraft(linked.grant.items);
  }, [linked, join.phase]);

  // The hub shows the devices that ask to join while a code is live.
  useEffect(() => {
    if (!hubOn || minted === undefined) return;
    let cancelled = false;
    const read = async () => {
      try {
        const next = await pairing.listRemotePairingRequests();
        if (!cancelled) setPending(next);
      } catch {
        // The next read tries again.
      }
    };
    void read();
    const timer = setInterval(() => void read(), PENDING_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [hubOn, minted, pairing]);

  // An expired code is dropped from state, not merely hidden.
  useEffect(() => {
    if (minted === undefined) return;
    const remaining = minted.expiresAt - clockRef.current();
    if (remaining <= 0) {
      setMinted(undefined);
      setCodeExpired(true);
      return;
    }
    const countdown = setInterval(() => setTick((tick) => tick + 1), 1_000);
    const timer = setTimeout(() => {
      setMinted(undefined);
      setCodeExpired(true);
    }, remaining);
    return () => {
      clearInterval(countdown);
      clearTimeout(timer);
    };
  }, [minted]);

  const toggle = (item: HubGrantItem, on: boolean) =>
    setDraft((items) =>
      HUB_GRANT_ITEMS.filter((each) => (each === item ? on : items.includes(each))),
    );

  const grantEditor = (current: Grant, actionLabel: string) => (
    <fieldset className="settings-panel__stack">
      <legend>What the hub may do here</legend>
      {HUB_GRANT_ITEMS.map((item) => (
        <label className="check" key={item}>
          <OctantCheckbox
            checked={draft.includes(item)}
            onChange={(event) => toggle(item, event.target.checked)}
          />
          <span>
            <strong>{GRANT_ITEM_COPY[item].label}</strong> · {GRANT_ITEM_COPY[item].line}
          </span>
        </label>
      ))}
      <p className="settings-section-line">
        This computer keeps its files, sign-ins, sandbox, and every approval whatever you tick. Only
        you can change this list.
      </p>
      <div className="host-settings__controls">
        <OctantButton
          disabled={busy}
          onClick={() => void saveGrant(draft, current)}
          size="sm"
          type="button"
          variant="default"
        >
          {actionLabel}
        </OctantButton>
      </div>
    </fieldset>
  );

  const timeLeft = minted === undefined ? undefined : Math.max(0, minted.expiresAt - clock());

  return (
    <>
      <SettingsSection title="Hub">
        {state.kind === "loading" ? (
          <SettingsState kind="loading">Reading the hub status…</SettingsState>
        ) : state.kind === "error" ? (
          <SettingsState kind="error">{state.message}</SettingsState>
        ) : null}
        <div className="setgroup">
          <SettingRow
            description="Turn this computer into the hub for your own devices. It needs the remote listener on a Tailscale or private LAN address. Off by default."
            label="Act as hub"
            scope="host"
            settingId="hub-role"
          >
            <OctantSwitch
              checked={hubOn}
              disabled={busy || status === undefined || linked !== undefined}
              {...(linked === undefined
                ? {}
                : { disabledReason: "Leave the hub this computer joined first." })}
              label="Act as hub"
              onCheckedChange={(on) => void setHubRole(on)}
            />
          </SettingRow>
        </div>
        {message === undefined ? null : (
          <SettingsState
            kind={
              /^(Approved|Denied|Removed|Left|Added|Confirm|Dismissed|The hub grant is saved)/.test(
                message,
              )
                ? "success"
                : "error"
            }
          >
            {message}
          </SettingsState>
        )}
      </SettingsSection>

      {!hubOn ? null : (
        <SettingsSection title="Add a device">
          <div className="settings-panel__stack">
            <label className="check">
              <OctantCheckbox
                checked={owner}
                id={ownerId}
                onChange={(event) => setOwner(event.target.checked)}
              />
              <span>The device that joins is an owner of this hub</span>
            </label>
            <div className="host-settings__controls">
              <OctantButton
                disabled={busy}
                onClick={() => void mintCode()}
                size="sm"
                type="button"
                variant="secondary"
              >
                Make a join code
              </OctantButton>
            </div>
            {minted === undefined || timeLeft === undefined ? null : (
              <>
                <PairingCodeQr code={minted.code} />
                <SettingsFactList
                  facts={[
                    {
                      label: "Code",
                      value: (
                        <code aria-label="Join code" className="oct-meta--mono remote-pairing-code">
                          {minted.code}
                        </code>
                      ),
                    },
                    { label: "Time left", value: formatTimeLeft(timeLeft) },
                    { label: "Owner", value: minted.owner ? "Yes" : "No" },
                  ]}
                />
                <p className="settings-section-line">
                  On the other computer, open Settings, Remote access, Join a hub, and paste this
                  code. On a phone, scan the QR code. Then compare the short code and approve here.
                </p>
              </>
            )}
            {codeExpired && minted === undefined ? (
              <SettingsState kind="empty">That join code expired. Make a new one.</SettingsState>
            ) : null}
            {pending.length === 0 ? null : (
              <ul aria-label="Join requests" className="settings-panel__stack">
                {pending.map((item) => (
                  <li className="settings-card" key={item.ticketId}>
                    <SettingsFactList
                      facts={[
                        { label: "Device", value: item.deviceLabel },
                        { label: "From", value: item.origin },
                        {
                          label: "Comparison code",
                          value: <span className="oct-meta--mono">{item.comparisonCode}</span>,
                        },
                      ]}
                    />
                    <p className="settings-section-line">
                      Approve only if the comparison code matches the one on the device.
                    </p>
                    <div className="host-settings__controls">
                      <OctantButton
                        onClick={() => void decide(item, "approve")}
                        size="sm"
                        type="button"
                        variant="default"
                      >
                        Approve {item.deviceLabel}
                      </OctantButton>
                      <OctantButton
                        onClick={() => void decide(item, "deny")}
                        size="sm"
                        type="button"
                        variant="secondary"
                      >
                        Deny {item.deviceLabel}
                      </OctantButton>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </SettingsSection>
      )}

      {!hubOn ? null : (
        <SettingsSection title="Members">
          {status === undefined || status.members.length === 0 ? (
            <SettingsState kind="empty">No device has joined this hub yet.</SettingsState>
          ) : (
            <ul aria-label="Hub members" className="setgroup">
              {status.members.map((member) => (
                <li className="setrow" key={member.memberId}>
                  <span className="setrow-label">{member.name}</span>
                  <p className="setrow-hint">
                    {member.role}
                    {member.owner ? " · owner" : ""}
                  </p>
                  {member.role === "hub" ? null : (
                    <div className="setrow-control">
                      <OctantButton
                        aria-label={`Remove ${member.name}`}
                        onClick={() => setRemoving(member)}
                        ref={removing?.memberId === member.memberId ? removeOpener : undefined}
                        size="sm"
                        type="button"
                        variant="secondary"
                      >
                        Remove…
                      </OctantButton>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
          {removing === undefined ? null : (
            <OctantConfirmDialog
              cancelLabel="Keep it"
              confirmLabel={`Remove ${removing.name}`}
              onCancel={() => setRemoving(undefined)}
              onConfirm={() => void removeMember(removing)}
              restoreFocus={removeOpener}
              title={`Remove ${removing.name} from this hub?`}
            >
              It loses its place in the roster. Every other member drops what it held for it at the
              next roster. It can join again with a new code.
            </OctantConfirmDialog>
          )}
        </SettingsSection>
      )}

      {!hubOn || status === undefined ? null : (
        <SettingsSection title="Owner devices">
          <p className="settings-section-line">
            An owner device can act on this hub with a window's powers after a fresh unlock. A
            device that joins with an owner code is listed here. Remove one from this window, and
            add it back later if you wish.
          </p>
          <OwnerDevices
            busy={busy}
            candidates={status.ownerCandidates}
            mismatches={[]}
            onAdd={addOwner}
            onRemove={removeOwner}
            owners={status.owners}
          />
        </SettingsSection>
      )}

      {linked === undefined || hubOn ? null : (
        <>
          <SettingsSection title="Owner devices">
            {linked.grant.items.includes("owners") ? (
              <>
                <p className="settings-section-line">
                  The hub lists the unlock key of a device that joined with an owner code. An owner
                  here is confirmed by you, in this window, by name and fingerprint: the hub cannot
                  add one.
                </p>
                <OwnerDevices
                  busy={busy}
                  candidates={linked.ownerCandidates}
                  mismatches={linked.ownerKeyMismatches}
                  onAdd={addOwner}
                  onRemove={removeOwner}
                  owners={linked.owners}
                />
              </>
            ) : (
              <SettingsState kind="empty">
                The Owners item is off in the hub grant, so owner devices cannot act here.
              </SettingsState>
            )}
          </SettingsSection>
          <SettingsSection title="New members">
            <NewMemberChecks
              alerts={linked.alerts}
              awaiting={linked.heldMembers}
              busy={busy}
              confirmNewMembers={linked.confirmNewMembers}
              onConfirm={(memberId, name) => void confirmMember(memberId, name)}
              onDismiss={(alert) => void settleAlert(alert, "dismiss")}
              onRemove={(alert) => void settleAlert(alert, "remove")}
              onSetConfirmNewMembers={(enabled) => void setConfirmNewMembers(enabled)}
            />
          </SettingsSection>
        </>
      )}

      {hubOn ? null : (
        <SettingsSection title="Join a hub">
          {linked !== undefined ? (
            <div className="settings-panel__stack">
              <SettingsFactList
                facts={[
                  { label: "Hub", value: linked.hubName },
                  {
                    label: "State",
                    value:
                      linked.membership === "removed" ? "The hub removed this computer" : "Joined",
                  },
                ]}
              />
              {linked.roster.length === 0 ? null : (
                <ul aria-label="Members of this hub" className="setgroup">
                  {linked.roster.map((member) => (
                    <li className="setrow" key={member.memberId}>
                      <span className="setrow-label">{member.name}</span>
                      <p className="setrow-hint">
                        {member.role}
                        {member.owner ? " · owner" : ""} ·{" "}
                        {member.role === "hub" || member.accepted
                          ? "accepted here"
                          : "not accepted here"}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
              {grantEditor(linked.grant, "Save the grant")}
              <div className="host-settings__controls">
                <OctantButton
                  aria-expanded={leaving}
                  aria-haspopup="dialog"
                  disabled={busy}
                  onClick={() => setLeaving(true)}
                  ref={leaveOpener}
                  size="sm"
                  type="button"
                  variant="secondary"
                >
                  Leave the hub…
                </OctantButton>
              </div>
              {!leaving ? null : (
                <OctantConfirmDialog
                  cancelLabel="Stay"
                  confirmLabel="Leave the hub"
                  onCancel={() => setLeaving(false)}
                  onConfirm={() => void leave()}
                  restoreFocus={leaveOpener}
                  title={`Leave ${linked.hubName}?`}
                >
                  The hub stops acting here and forgets this computer. Your threads, Projects, and
                  sign-ins stay as they are.
                </OctantConfirmDialog>
              )}
            </div>
          ) : join.phase === "grant" ? (
            <div className="settings-panel__stack">
              <SettingsState kind="success">{`Joined ${join.hubName}.`}</SettingsState>
              {grantEditor(join.grant, "Accept")}
            </div>
          ) : join.phase === "comparing" ? (
            <div className="settings-panel__stack">
              <SettingsFactList
                facts={[
                  { label: "Hub", value: join.hubName },
                  {
                    label: "Key fingerprint",
                    value: <span className="oct-meta--mono">{join.fingerprint}</span>,
                  },
                  {
                    label: "Comparison code",
                    value: <span className="oct-meta--mono">{join.comparisonCode}</span>,
                  },
                ]}
              />
              <p className="settings-section-line">
                Approve on the hub only if its comparison code matches this one. Waiting for the
                hub…
              </p>
            </div>
          ) : (
            <div className="settings-panel__stack">
              <OctantField>
                <OctantFieldLabel htmlFor={codeId}>Join code</OctantFieldLabel>
                <OctantTextarea
                  autoComplete="off"
                  id={codeId}
                  onChange={(event) => setJoinCode(event.target.value)}
                  rows={3}
                  spellCheck={false}
                  value={joinCode}
                />
              </OctantField>
              <p className="settings-section-line">
                Paste a join code from a hub's Add a device screen. The hub must be reachable over
                Tailscale or the same LAN, and this computer needs its own remote listener on.
              </p>
              <div className="host-settings__controls">
                <OctantButton
                  disabled={busy || joinCode.trim() === ""}
                  onClick={() => void startJoin()}
                  size="sm"
                  type="button"
                  variant="default"
                >
                  Join the hub
                </OctantButton>
              </div>
            </div>
          )}
        </SettingsSection>
      )}

      {certificate === undefined ? null : (
        <SettingsSection title="Tailscale certificate">
          <div className="setgroup">
            <SettingRow
              description="Lets a browser on your tailnet open this computer's web app without a warning. Off by default."
              label="Use a Tailscale certificate"
              scope="host"
              settingId="hub-tailscale-certificate"
            >
              <OctantSwitch
                checked={certificate.enabled}
                disabled={busy || (!certificate.enabled && !transparencyRead)}
                {...(!certificate.enabled && !transparencyRead
                  ? { disabledReason: "Read and tick the note below first." }
                  : {})}
                label="Use a Tailscale certificate"
                onCheckedChange={(on) => void setTailscaleCertificate(on)}
              />
            </SettingRow>
          </div>
          {certificate.enabled ? (
            <SettingsFactList
              facts={[
                ...(certificate.domain === undefined
                  ? []
                  : [{ label: "Name", value: certificate.domain }]),
                ...(certificate.renewal === undefined
                  ? []
                  : [{ label: "Renewal", value: certificate.renewal }]),
              ]}
            />
          ) : (
            <label className="check" htmlFor={transparencyId}>
              <OctantCheckbox
                checked={transparencyRead}
                id={transparencyId}
                onChange={(event) => setTransparencyRead(event.target.checked)}
              />
              <span>
                Tailscale gets this certificate from a public authority, so this computer's tailnet
                name will appear in public certificate-transparency logs. I have read this.
              </span>
            </label>
          )}
        </SettingsSection>
      )}
    </>
  );
}

function formatTimeLeft(milliseconds: number): string {
  const seconds = Math.ceil(milliseconds / 1_000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** The server's refusal as a plain sentence, else the fallback. */
function refusalText(reply: Reply, fallback: string): string {
  const kind = field(reply.body, "kind");
  if (field(reply.body, "status") === "refused" && typeof kind === "string") {
    return REFUSAL_COPY[kind] ?? fallback;
  }
  const detail = field(reply.body, "message");
  return typeof detail === "string" && detail !== "" ? detail : fallback;
}

function readStatus(body: unknown): HubStatus | undefined {
  const hub = field(body, "hub");
  const spoke = field(body, "spoke");
  const enabled = field(hub, "enabled");
  if (typeof enabled !== "boolean") return undefined;
  const members = readMembers(field(field(field(hub, "roster"), "roster"), "members"));
  const membership = field(spoke, "membership");
  const hubName = field(field(spoke, "hub"), "name");
  const grant = readGrant(field(spoke, "grant"));
  if (
    (membership === "member" || membership === "removed") &&
    typeof hubName === "string" &&
    grant !== undefined
  ) {
    const acceptedIds = field(spoke, "acceptedMemberIds");
    const accepted = new Set(
      Array.isArray(acceptedIds) ? acceptedIds.filter((id) => typeof id === "string") : [],
    );
    const roster = readMembers(field(field(field(spoke, "roster"), "roster"), "members")).map(
      (member) => ({ ...member, accepted: accepted.has(member.memberId) }),
    );
    return {
      enabled,
      members,
      owners: readOwners(field(hub, "owners")),
      ownerCandidates: readOwnerCandidates(field(hub, "ownerCandidates")),
      link: {
        membership,
        hubName,
        grant,
        roster,
        owners: readOwners(field(spoke, "owners")),
        ownerCandidates: readOwnerCandidates(field(spoke, "ownerCandidates")),
        ownerKeyMismatches: readKeyMismatches(field(spoke, "ownerKeyMismatches")),
        confirmNewMembers: field(spoke, "confirmNewMembers") === true,
        heldMembers: readHeldMembers(field(spoke, "heldMembers")),
        alerts: readAlerts(field(spoke, "alerts")),
      },
    };
  }
  return {
    enabled,
    members,
    owners: readOwners(field(hub, "owners")),
    ownerCandidates: readOwnerCandidates(field(hub, "ownerCandidates")),
  };
}

function readOwnerCandidates(rows: unknown): OwnerCandidateRow[] {
  const candidates: OwnerCandidateRow[] = [];
  for (const entry of Array.isArray(rows) ? rows : []) {
    const memberId = field(entry, "memberId");
    const name = field(entry, "name");
    const identity = field(entry, "identityKeyFingerprint");
    const unlock = field(entry, "unlockKeyFingerprint");
    if (
      typeof memberId === "string" &&
      typeof name === "string" &&
      typeof identity === "string" &&
      typeof unlock === "string"
    ) {
      candidates.push({
        memberId,
        name,
        identityKeyFingerprint: identity,
        unlockKeyFingerprint: unlock,
      });
    }
  }
  return candidates;
}

function readKeyMismatches(rows: unknown): OwnerKeyMismatchRow[] {
  const mismatches: OwnerKeyMismatchRow[] = [];
  for (const entry of Array.isArray(rows) ? rows : []) {
    const memberId = field(entry, "memberId");
    const name = field(entry, "name");
    const held = field(entry, "heldUnlockKeyFingerprint");
    const listed = field(entry, "rosterUnlockKeyFingerprint");
    if (
      typeof memberId === "string" &&
      typeof name === "string" &&
      typeof held === "string" &&
      typeof listed === "string"
    ) {
      mismatches.push({
        memberId,
        name,
        heldUnlockKeyFingerprint: held,
        rosterUnlockKeyFingerprint: listed,
      });
    }
  }
  return mismatches;
}

function readHeldMembers(rows: unknown): HeldMemberRow[] {
  const held: HeldMemberRow[] = [];
  for (const entry of Array.isArray(rows) ? rows : []) {
    const memberId = field(entry, "memberId");
    const name = field(entry, "name");
    const identity = field(entry, "identityKeyFingerprint");
    if (typeof memberId === "string" && typeof name === "string" && typeof identity === "string") {
      held.push({ memberId, name, identityKeyFingerprint: identity });
    }
  }
  return held;
}

function readMembers(rows: unknown): Member[] {
  const members: Member[] = [];
  for (const entry of Array.isArray(rows) ? rows : []) {
    const memberId = field(entry, "memberId");
    const name = field(entry, "name");
    const role = field(entry, "role");
    const identityKeyFingerprint = field(entry, "identityKeyFingerprint");
    if (typeof memberId === "string" && typeof name === "string" && typeof role === "string") {
      members.push({
        memberId,
        name,
        role,
        owner: field(entry, "owner") === true,
        identityKeyFingerprint:
          typeof identityKeyFingerprint === "string" ? identityKeyFingerprint : "",
      });
    }
  }
  return members;
}

function readOwners(rows: unknown): OwnerRow[] {
  const owners: OwnerRow[] = [];
  for (const entry of Array.isArray(rows) ? rows : []) {
    const memberId = field(entry, "memberId");
    const name = field(entry, "name");
    const identity = field(entry, "identityKeyFingerprint");
    const unlock = field(entry, "unlockKeyFingerprint");
    if (
      typeof memberId === "string" &&
      typeof name === "string" &&
      typeof identity === "string" &&
      typeof unlock === "string"
    ) {
      owners.push({
        memberId,
        name,
        identityKeyFingerprint: identity,
        unlockKeyFingerprint: unlock,
      });
    }
  }
  return owners;
}

function readAlerts(rows: unknown): NewMemberAlertRow[] {
  const alerts: NewMemberAlertRow[] = [];
  for (const entry of Array.isArray(rows) ? rows : []) {
    const alertId = field(entry, "alertId");
    const memberId = field(entry, "memberId");
    const name = field(entry, "name");
    const role = field(entry, "role");
    const identity = field(entry, "identityKeyFingerprint");
    if (
      typeof alertId === "string" &&
      typeof memberId === "string" &&
      typeof name === "string" &&
      typeof role === "string" &&
      typeof identity === "string"
    ) {
      alerts.push({ alertId, memberId, name, role, identityKeyFingerprint: identity });
    }
  }
  return alerts;
}

function readCertificate(body: unknown): CertificateStatus | undefined {
  const enabled = field(body, "enabled");
  if (typeof enabled !== "boolean") return undefined;
  const domain = field(body, "domain");
  const renewal = field(body, "renewal");
  return {
    enabled,
    ...(typeof domain === "string" ? { domain } : {}),
    ...(renewal === "current" || renewal === "due" || renewal === "expired" ? { renewal } : {}),
  };
}

function readGrant(value: unknown): Grant | undefined {
  const items = field(value, "items");
  const projects = field(value, "actProjects");
  if (!Array.isArray(items) || !Array.isArray(projects)) return undefined;
  return {
    items: HUB_GRANT_ITEMS.filter((item) => items.includes(item)),
    actProjects: projects.filter((project): project is string => typeof project === "string"),
  };
}

function field(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return (value as Record<string, unknown>)[key];
}
