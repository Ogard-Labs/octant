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
  OwnerUnlockBridge,
  RemoteAccessAdministrationBridge,
  RemotePendingPairingRequest,
} from "../shell/hostBridge";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantCheckbox } from "../ui/base/OctantCheckbox";
import { OctantConfirmDialog } from "../ui/base/OctantConfirmDialog";
import { OctantField, OctantFieldLabel } from "../ui/base/OctantField";
import { OctantInput } from "../ui/base/OctantInput";
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
  /**
   * This Mac's unlock key (Touch ID or the account password). Joining a hub
   * makes it and presents its public half, which the hub keeps only when the
   * code was an owner code. Absent when the desktop has none to offer.
   */
  readonly ownerUnlock?: Pick<OwnerUnlockBridge, "ownerUnlockMakeKey" | "ownerUnlockForgetKey">;
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
  "sign-in": {
    label: "Sign-in",
    line: "Let the hub ask you to sign in to a provider account here. Nothing starts until you accept.",
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
  "standby-not-granted":
    "That computer's person has not ticked Standby in its hub grant, so it cannot be a standby.",
  "member-unreachable": "Octant could not reach that computer to ask it. Nothing changed.",
  "unknown-member": "That is not a member of this hub.",
  "duplicate-member": "A computer can be named only once.",
  "not-a-named-standby": "The hub has not named this computer a standby.",
  "already-hub": "This computer is already the hub.",
  "invalid-address": "That is not a hardware address (six hex pairs, such as aa:bb:cc:00:11:22).",
};

/** How the hub's last attempt to wake a spoke went, in words. */
const WAKE_RESULT_COPY: Readonly<Record<string, string>> = {
  nudged: "nudged, and the computer answered",
  ignored: "the computer did not act on it",
  refused: "the computer refused it",
  unreachable: "the computer could not be reached",
};

/** How the hub's last forward for a spoke went, in words. */
const PUSH_RESULT_COPY: Readonly<Record<string, string>> = {
  forwarded: "the gateway took it",
  failed: "the gateway did not take it",
  refused: "the hub refused it",
};

/** How the hub's last offer to a spoke went, in words. */
const OFFER_RESULT_COPY: Readonly<Record<string, string>> = {
  proposed: "holds it as a proposal",
  refused: "did not take it",
  unreachable: "could not be reached",
};

/** What a proposal asks of this computer, in words, for the person who applies it. */
function proposalSummary(offer: ProposalOffer): string {
  switch (offer.kind) {
    case "update-channel":
      return `Follow the ${offer.channel} update channel${offer.mirror === true ? ", checking the hub's copy of the signed feed" : ""}.`;
    case "plugin":
      return `Install ${offer.entryId} from the ${offer.catalogId} catalog. It arrives untrusted and switched off.`;
    case "agent-profile":
      return `Add the profile “${offer.displayName}”.`;
    case "model-endpoint":
      return `Add the endpoint “${offer.displayName}” at ${offer.baseUrl}. It arrives switched off and without a key.`;
    case "routine":
      return `A routine, “${offer.displayName}”. You choose its Project and it runs under this computer's own limits.`;
  }
}

interface Reply {
  readonly status: number;
  readonly body: unknown;
}

const SIGN_IN_KINDS: ReadonlyArray<{ readonly kind: string; readonly label: string }> = [
  { kind: "claude-subscription", label: "Claude account" },
  { kind: "codex-subscription", label: "Codex account" },
];

const signInKindLabel = (kind: string) =>
  SIGN_IN_KINDS.find((entry) => entry.kind === kind)?.label ?? "account";

/** Why a computer did not take a sign-in request, in the words the hub's person reads. */
const SIGN_IN_REFUSAL_COPY: Readonly<Record<string, string>> = {
  "hub-role-off": "The hub role is off.",
  "unknown-member": "That computer is not a member of this hub.",
  unreachable: "Octant could not reach that computer.",
  "sign-in-not-granted": "That computer's person did not allow sign-in requests.",
  "unknown-kind": "That computer has no such account to sign in to.",
  "already-signed-in": "That account is already signed in there.",
  "already-asked": "That computer already has a request for this account.",
  "rate-limited": "That computer has had enough requests this hour. Try again later.",
  "answer-refused": "That computer did not take the request.",
};

/** What the hub shows beside a member about its last sign-in request: one word. */
function signInResultText(result: string): string {
  switch (result) {
    case "asked":
      return "waiting for its person";
    case "signed-in":
      return "signed in";
    case "declined":
      return "declined";
    case "expired":
      return "expired";
    case "failed":
      return "failed";
    default:
      return SIGN_IN_REFUSAL_COPY[result.replace(/^refused:/, "")] ?? "not taken";
  }
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
  /** The standby hubs this hub's roster names, in the order members try them. */
  readonly standbyOrder: ReadonlyArray<string>;
  readonly wake?: WakeView;
  readonly push?: PushView;
  readonly provision?: ProvisionView;
  readonly signIn?: SignInView;
  readonly link?: {
    readonly membership: "member" | "removed";
    readonly hubName: string;
    readonly grant: Grant;
    /** This computer is a named standby: its own window may make it the hub for good. */
    readonly namedStandby: boolean;
    /** The roster this computer holds was signed by a standby because the hub is unreachable. */
    readonly followsStandby: boolean;
    /** Set while this computer stands in for a hub it cannot reach. */
    readonly standIn?: {
      readonly startedAt: number;
      readonly added: number;
      readonly removed: number;
    };
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

/** The fields of an offer a proposal shows; the host holds the rest. */
interface ProposalOffer {
  readonly kind: "update-channel" | "plugin" | "agent-profile" | "model-endpoint" | "routine";
  readonly channel?: string;
  readonly mirror?: boolean;
  readonly catalogId?: string;
  readonly entryId?: string;
  readonly displayName?: string;
  readonly baseUrl?: string;
}

/** Offers as this window sees them: the hub's offers and how each spoke took them, and this computer's proposals. */
interface ProvisionView {
  readonly hub: {
    readonly enabled: boolean;
    readonly offers: ReadonlyArray<{
      readonly offerId: string;
      readonly kind: string;
      readonly deliveries: ReadonlyArray<{
        readonly memberId: string;
        readonly result: string;
        readonly reason?: string;
      }>;
    }>;
  };
  readonly spoke: {
    readonly offering: boolean;
    readonly autoApply: ReadonlyArray<string>;
    readonly proposals: ReadonlyArray<{
      readonly offerId: string;
      readonly offer: ProposalOffer;
      readonly expiresAt: string;
    }>;
  };
}

/**
 * Hub-started sign-in as this window sees it: the hub's last request to each
 * member with its one result word, and the requests this computer's person has
 * yet to answer. The command to run is shown only here, after Accept.
 */
interface SignInView {
  readonly hub: ReadonlyArray<{
    readonly memberId: string;
    readonly kind: string;
    /** `asked`, an outcome word, or `refused:<reason>`. */
    readonly result: string;
  }>;
  readonly spoke: {
    readonly accepting: boolean;
    readonly requests: ReadonlyArray<{
      readonly requestId: string;
      readonly kind: string;
      readonly state: "asked" | "accepted";
      readonly expiresAt: string;
      readonly guidance?: string;
    }>;
  };
}

const AUTO_APPLY_KINDS: ReadonlyArray<{
  readonly kind: "update-channel" | "plugin" | "agent-profile";
  readonly label: string;
}> = [
  { kind: "update-channel", label: "Update channel" },
  { kind: "plugin", label: "Plugin install (untrusted and off)" },
  { kind: "agent-profile", label: "Agent profile (no secrets)" },
];

/** The push sender as this window sees it: the hub's switch and what it counted, and whether this computer hands its notifications on. */
interface PushView {
  readonly hub: {
    readonly enabled: boolean;
    readonly spokes: ReadonlyArray<{
      readonly memberId: string;
      readonly forwarded: number;
      readonly refused: number;
      readonly lastResult?: { readonly at: number; readonly result: string };
    }>;
  };
  readonly spoke: { readonly handing: boolean };
}

/** The wake service as this window sees it: the hub's switch and times, and this computer's side as a spoke. */
interface WakeView {
  readonly hub: {
    readonly enabled: boolean;
    readonly spokes: ReadonlyArray<{
      readonly memberId: string;
      readonly upcoming: number;
      readonly lastResult?: { readonly at: number; readonly result: string };
    }>;
  };
  readonly spoke: { readonly sharing: boolean; readonly hardwareAddress?: string };
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

export function HubSettingsSection({ hub, pairing, ownerUnlock, now }: HubSettingsSectionProps) {
  const clock = now ?? (() => Date.now());
  /** The public half of the unlock key made for the join in progress; the private half never leaves the Secure Enclave. */
  const unlockPublicKey = useRef<string | undefined>(undefined);
  const forgetUnlockKey = useCallback(async () => {
    unlockPublicKey.current = undefined;
    await ownerUnlock?.ownerUnlockForgetKey().catch(() => undefined);
  }, [ownerUnlock]);
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
  const [askingMemberId, setAskingMemberId] = useState<string>();
  const [leaving, setLeaving] = useState(false);
  const [promoting, setPromoting] = useState(false);
  /** The standby order being edited; absent while the window shows the order the hub holds. */
  const [standbyDraft, setStandbyDraft] = useState<ReadonlyArray<string>>();
  /** The hardware address being typed; absent while the field shows the one this computer holds. */
  const [addressDraft, setAddressDraft] = useState<string>();
  const addressId = useId();
  const promoteOpener = useRef<HTMLButtonElement>(null);
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
      unlockPublicKey.current = undefined;
      if (ownerUnlock !== undefined) {
        const made = await ownerUnlock.ownerUnlockMakeKey().catch(() => undefined);
        if (made?.status === "done" && made.publicKey !== undefined) {
          unlockPublicKey.current = made.publicKey;
        } else {
          setMessage(
            "This Mac could not make an unlock key (it needs Touch ID or an account password), so it joins without one and cannot act as an owner.",
          );
        }
      }
      setJoin({ phase: "comparing", hubName, fingerprint, comparisonCode });
    }
  };

  const leave = async () => {
    setLeaving(false);
    const reply = await act("leave", undefined, "left", "Octant could not leave the hub.");
    if (reply !== undefined) {
      await forgetUnlockKey();
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

  const heldStandbyOrder = status?.standbyOrder ?? [];
  const standbyOrder = standbyDraft ?? heldStandbyOrder;
  const standbyChanged =
    standbyDraft !== undefined && standbyDraft.join() !== heldStandbyOrder.join();
  const nameOf = (memberId: string) =>
    status?.members.find((member) => member.memberId === memberId)?.name ?? memberId;

  const moveStandby = (index: number, by: -1 | 1) => {
    const next = [...standbyOrder];
    const [moved] = next.splice(index, 1);
    if (moved !== undefined) next.splice(index + by, 0, moved);
    setStandbyDraft(next);
  };

  const saveStandbyOrder = async () => {
    const reply = await act(
      "standby-order",
      { memberIds: standbyOrder },
      "ordered",
      "Octant could not set the standby order.",
    );
    if (reply !== undefined) {
      setStandbyDraft(undefined);
      setMessage("Standby order saved.");
    }
    await refresh();
  };

  const setWakeService = async (on: boolean) => {
    const reply = await act(
      "wake",
      { enabled: on },
      "changed",
      on
        ? "Octant could not turn on the wake service."
        : "Octant could not turn off the wake service.",
    );
    if (reply !== undefined) {
      setMessage(
        on
          ? "Wake service is on. A computer takes part only if its person ticked Wake."
          : "Wake service is off. The hub forgot every time it held.",
      );
    }
    await refresh();
  };

  const setPushSender = async (on: boolean) => {
    const reply = await act(
      "push",
      { enabled: on },
      "changed",
      on
        ? "Octant could not turn on the push sender."
        : "Octant could not turn off the push sender.",
    );
    if (reply !== undefined) {
      setMessage(
        on
          ? "Push sender is on. A computer uses it only if its person ticked Push."
          : "Push sender is off. The hub forgot its counts.",
      );
    }
    await refresh();
  };

  const setOffers = async (on: boolean) => {
    const reply = await act(
      "provision",
      { enabled: on },
      "changed",
      on ? "Octant could not turn on offers." : "Octant could not turn off offers.",
    );
    if (reply !== undefined) {
      setMessage(
        on
          ? "Offers are on. A computer holds an offer only if its person ticked Provision."
          : "Offers are off. The hub forgot the offers it held.",
      );
    }
    await refresh();
  };

  const offerChannel = async (channel: "stable" | "preview") => {
    const reply = await act(
      "provision-offer",
      { offer: { kind: "update-channel", channel } },
      "offered",
      "Octant could not make that offer.",
    );
    if (reply !== undefined) {
      setMessage(`Offered the ${channel} update channel. Each computer's person applies it.`);
    }
    await refresh();
  };

  const withdrawOffer = async (offerId: string) => {
    const reply = await act(
      "provision-withdraw",
      { offerId },
      "withdrawn",
      "Octant could not withdraw that offer.",
    );
    if (reply !== undefined)
      setMessage("Offer withdrawn. Proposals already held stay with their person.");
    await refresh();
  };

  const askToSignIn = async (member: Member, kind: string) => {
    setAskingMemberId(undefined);
    const reply = await act(
      "sign-in-ask",
      { memberId: member.memberId, kind },
      "asked",
      `Octant could not ask ${member.name} to sign in.`,
      SIGN_IN_REFUSAL_COPY,
    );
    if (reply !== undefined) {
      setMessage(
        `Asked ${member.name} to sign in to its ${signInKindLabel(kind)}. Its person decides, and finishes the sign-in on that computer.`,
      );
    }
    await refresh();
  };

  const answerSignIn = async (
    operation: "sign-in-accept" | "sign-in-decline" | "sign-in-check",
    requestId: string,
  ) => {
    if (operation !== "sign-in-check") {
      await act(
        operation,
        { requestId },
        operation === "sign-in-accept" ? "accepted" : "declined",
        "Octant could not answer that request.",
        SIGN_IN_REFUSAL_COPY,
      );
      await refresh();
      return;
    }
    // A check can answer "not yet", which is not a failure, so it reads its own reply.
    setMessage(undefined);
    setBusy(true);
    try {
      const reply = await request(operation, { requestId });
      const answer = field(reply.body, "status");
      if (reply.status === 200 && answer === "ended") {
        setMessage(
          field(reply.body, "outcome") === "signed-in"
            ? "Signed in. The hub is told the result."
            : "Octant could not read that sign-in. The hub is told it failed.",
        );
      } else if (reply.status === 200 && answer === "pending") {
        setMessage("Not signed in yet. Finish the sign-in in the terminal, then check again.");
      } else {
        setMessage(refusalText(reply, "Octant could not check that sign-in."));
      }
    } catch (error) {
      setMessage(failureMessage(error, "Octant could not check that sign-in."));
    } finally {
      setBusy(false);
    }
    await refresh();
  };

  const decideProposal = async (offerId: string, apply: boolean) => {
    const reply = await act(
      apply ? "provision-apply" : "provision-dismiss",
      { offerId },
      apply ? "applied" : "dismissed",
      apply ? "Octant could not apply that proposal." : "Octant could not dismiss that proposal.",
    );
    if (reply !== undefined) setMessage(apply ? "Offer applied." : "Dismissed.");
    await refresh();
  };

  const setAutoApply = async (kind: string, enabled: boolean) => {
    await act(
      "provision-auto-apply",
      { kind, enabled },
      "changed",
      "Octant could not change that.",
    );
    await refresh();
  };

  const saveHardwareAddress = async (address: string | null) => {
    const reply = await act(
      "wake-hardware-address",
      { address },
      "changed",
      "Octant could not save the hardware address.",
    );
    if (reply !== undefined) {
      setMessage(
        address === null ? "Hardware address cleared." : "Hardware address saved on this computer.",
      );
      setAddressDraft(undefined);
    }
    await refresh();
  };

  const promote = async () => {
    setPromoting(false);
    const reply = await act(
      "promote",
      { confirmed: true },
      "promoted",
      "Octant could not make this computer the hub.",
    );
    if (reply !== undefined) {
      setMessage(
        "This computer is now the hub. Each other computer accepts it from its own window.",
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
        const reply =
          unlockPublicKey.current === undefined
            ? await request("join-finish")
            : await request("join-finish", { unlockPublicKey: unlockPublicKey.current });
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
      // The join ended without this computer joining, so the key made for it has no hub.
      void forgetUnlockKey();
      setJoin({ phase: "idle" });
    };
    let timer = setTimeout(() => void ask(), 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [join, request, forgetUnlockKey]);

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
              /^(Approved|Denied|Removed|Left|Added|Confirm|Dismissed|The hub grant is saved|Standby order saved|This computer is now the hub|Wake service is|Push sender is|Offers are|Offered|Offer withdrawn|Offer applied|Hardware address)/.test(
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
                    {(status.signIn?.hub ?? [])
                      .filter((entry) => entry.memberId === member.memberId)
                      .map((entry) => (
                        <span key={entry.kind}>
                          {` · ${signInKindLabel(entry.kind)}: ${signInResultText(entry.result)}`}
                        </span>
                      ))}
                  </p>
                  {member.role === "hub" ? null : (
                    <div className="setrow-control">
                      {member.role !== "spoke" &&
                      member.role !== "standby-hub" ? null : askingMemberId === member.memberId ? (
                        SIGN_IN_KINDS.map((entry) => (
                          <OctantButton
                            aria-label={`Ask ${member.name} to sign in to its ${entry.label}`}
                            disabled={busy}
                            key={entry.kind}
                            onClick={() => void askToSignIn(member, entry.kind)}
                            size="sm"
                            type="button"
                            variant="secondary"
                          >
                            {entry.label}
                          </OctantButton>
                        ))
                      ) : (
                        <OctantButton
                          aria-label={`Ask ${member.name} to sign in`}
                          disabled={busy}
                          onClick={() => setAskingMemberId(member.memberId)}
                          size="sm"
                          type="button"
                          variant="secondary"
                        >
                          Ask to sign in
                        </OctantButton>
                      )}
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
        <SettingsSection title="Standby hubs">
          <p className="settings-section-line">
            A standby hub takes over the roster while this hub is unreachable, and hands its changes
            back when this hub returns. Members try the standbys in this order. A computer can be a
            standby only if its own person ticked Standby in its hub grant. Only this window changes
            the order.
          </p>
          {standbyOrder.length === 0 ? (
            <SettingsState kind="empty">No standby hub is named.</SettingsState>
          ) : (
            <ol aria-label="Standby order" className="setgroup">
              {standbyOrder.map((memberId, index) => (
                <li className="setrow" key={memberId}>
                  <span className="setrow-label">{`${index + 1}. ${nameOf(memberId)}`}</span>
                  <div className="setrow-control">
                    <OctantButton
                      aria-label={`Move ${nameOf(memberId)} up`}
                      disabled={busy || index === 0}
                      onClick={() => moveStandby(index, -1)}
                      size="sm"
                      type="button"
                      variant="secondary"
                    >
                      Up
                    </OctantButton>
                    <OctantButton
                      aria-label={`Move ${nameOf(memberId)} down`}
                      disabled={busy || index === standbyOrder.length - 1}
                      onClick={() => moveStandby(index, 1)}
                      size="sm"
                      type="button"
                      variant="secondary"
                    >
                      Down
                    </OctantButton>
                    <OctantButton
                      aria-label={`Stop ${nameOf(memberId)} being a standby`}
                      disabled={busy}
                      onClick={() => setStandbyDraft(standbyOrder.filter((id) => id !== memberId))}
                      size="sm"
                      type="button"
                      variant="secondary"
                    >
                      Remove
                    </OctantButton>
                  </div>
                </li>
              ))}
            </ol>
          )}
          <div className="host-settings__controls">
            {status.members
              .filter(
                (member) =>
                  (member.role === "spoke" || member.role === "standby-hub") &&
                  !standbyOrder.includes(member.memberId),
              )
              .map((member) => (
                <OctantButton
                  aria-label={`Name ${member.name} a standby`}
                  disabled={busy}
                  key={member.memberId}
                  onClick={() => setStandbyDraft([...standbyOrder, member.memberId])}
                  size="sm"
                  type="button"
                  variant="secondary"
                >
                  {`Add ${member.name}`}
                </OctantButton>
              ))}
            <OctantButton
              disabled={busy || !standbyChanged}
              onClick={() => void saveStandbyOrder()}
              size="sm"
              type="button"
              variant="default"
            >
              Save the standby order
            </OctantButton>
          </div>
        </SettingsSection>
      )}

      {!hubOn || status === undefined ? null : (
        <SettingsSection title="Wake service">
          <div className="setgroup">
            <SettingRow
              description="Wake a spoke's computer just before one of its routines is due. A computer takes part only if its own person ticked Wake in its hub grant. The hub learns only a time and an opaque id for each routine, never what it does. Off by default."
              label="Wake service"
              scope="host"
              settingId="hub-wake-service"
            >
              <OctantSwitch
                checked={status.wake?.hub.enabled === true}
                disabled={busy}
                label="Wake service"
                onCheckedChange={(on) => void setWakeService(on)}
              />
            </SettingRow>
          </div>
          {status.wake?.hub.enabled !== true ? null : status.wake.hub.spokes.length === 0 ? (
            <SettingsState kind="empty">
              No spoke has told the hub a routine time yet.
            </SettingsState>
          ) : (
            <ul aria-label="Spokes the hub wakes" className="setgroup">
              {status.wake.hub.spokes.map((spoke) => (
                <li className="setrow" key={spoke.memberId}>
                  <span className="setrow-label">{nameOf(spoke.memberId)}</span>
                  <p className="setrow-hint">
                    {`${spoke.upcoming} wake${spoke.upcoming === 1 ? "" : "s"} ahead · ${
                      spoke.lastResult === undefined
                        ? "not woken yet"
                        : `last ${WAKE_RESULT_COPY[spoke.lastResult.result] ?? spoke.lastResult.result}`
                    }`}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </SettingsSection>
      )}

      {!hubOn || status === undefined ? null : (
        <SettingsSection title="Push sender">
          <div className="setgroup">
            <SettingRow
              description="Send phone notifications for your spokes. A computer hands the hub notifications already sealed to your phone, signed by itself, and the hub passes them to the push gateway named in this computer's Notifications setting. The hub cannot read them or sign for a computer. A computer takes part only if its own person ticked Push in its hub grant. Off by default."
              label="Push sender"
              scope="host"
              settingId="hub-push-sender"
            >
              <OctantSwitch
                checked={status.push?.hub.enabled === true}
                disabled={busy}
                label="Push sender"
                onCheckedChange={(on) => void setPushSender(on)}
              />
            </SettingRow>
          </div>
          {status.push?.hub.enabled !== true ? null : status.push.hub.spokes.length === 0 ? (
            <SettingsState kind="empty">
              The hub has not forwarded a notification yet.
            </SettingsState>
          ) : (
            <ul aria-label="Spokes the hub forwards for" className="setgroup">
              {status.push.hub.spokes.map((spoke) => (
                <li className="setrow" key={spoke.memberId}>
                  <span className="setrow-label">{nameOf(spoke.memberId)}</span>
                  <p className="setrow-hint">
                    {`${spoke.forwarded} forwarded · ${spoke.refused} refused · ${
                      spoke.lastResult === undefined
                        ? "nothing yet"
                        : `last ${PUSH_RESULT_COPY[spoke.lastResult.result] ?? spoke.lastResult.result}`
                    }`}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </SettingsSection>
      )}

      {!hubOn || status === undefined ? null : (
        <SettingsSection title="Offers">
          <div className="setgroup">
            <SettingRow
              description="Offer your spokes configuration: an update channel, a plugin from the catalog, an agent profile, a model endpoint, or a routine. Each lands on a computer as a proposal its own person applies or dismisses, and only on a computer whose person ticked Provision. An offer never installs trusted, switches anything on, or carries a key. Off by default."
              label="Offers"
              scope="host"
              settingId="hub-offers"
            >
              <OctantSwitch
                checked={status.provision?.hub.enabled === true}
                disabled={busy}
                label="Offers"
                onCheckedChange={(on) => void setOffers(on)}
              />
            </SettingRow>
          </div>
          {status.provision?.hub.enabled !== true ? null : (
            <>
              <div className="host-settings__controls">
                {(["stable", "preview"] as const).map((channel) => (
                  <OctantButton
                    disabled={busy}
                    key={channel}
                    onClick={() => void offerChannel(channel)}
                    size="sm"
                    type="button"
                    variant="secondary"
                  >
                    {`Offer the ${channel} update channel`}
                  </OctantButton>
                ))}
              </div>
              <p className="settings-section-line">
                Plugins, profiles, endpoints, and routines are offered with `octant hub offer`.
              </p>
              {status.provision.hub.offers.length === 0 ? (
                <SettingsState kind="empty">The hub holds no offers.</SettingsState>
              ) : (
                <ul aria-label="Offers the hub holds" className="setgroup">
                  {status.provision.hub.offers.map((offer) => (
                    <li className="setrow" key={offer.offerId}>
                      <span className="setrow-label">{offer.kind}</span>
                      <p className="setrow-hint">
                        {offer.deliveries.length === 0
                          ? "Not handed to any computer."
                          : offer.deliveries
                              .map(
                                (delivery) =>
                                  `${nameOf(delivery.memberId)} ${OFFER_RESULT_COPY[delivery.result] ?? delivery.result}`,
                              )
                              .join(" · ")}
                      </p>
                      <OctantButton
                        disabled={busy}
                        onClick={() => void withdrawOffer(offer.offerId)}
                        size="sm"
                        type="button"
                        variant="secondary"
                      >
                        Withdraw
                      </OctantButton>
                    </li>
                  ))}
                </ul>
              )}
            </>
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
                      linked.membership === "removed"
                        ? "The hub removed this computer"
                        : linked.standIn !== undefined
                          ? "Standing in for the hub"
                          : linked.followsStandby
                            ? "The hub is unreachable: following the standby"
                            : "Joined",
                  },
                ]}
              />
              {linked.standIn === undefined ? null : (
                <p className="settings-section-line">
                  {`This computer saw no hub for the failover time and now serves the roster. Since then it added ${linked.standIn.added} and removed ${linked.standIn.removed}. It hands those changes back when the hub answers.`}
                </p>
              )}
              {!linked.namedStandby || linked.membership !== "member" ? null : (
                <div className="host-settings__controls">
                  <OctantButton
                    aria-expanded={promoting}
                    aria-haspopup="dialog"
                    disabled={busy}
                    onClick={() => setPromoting(true)}
                    ref={promoteOpener}
                    size="sm"
                    type="button"
                    variant="secondary"
                  >
                    Make this computer the hub…
                  </OctantButton>
                </div>
              )}
              {!promoting ? null : (
                <OctantConfirmDialog
                  cancelLabel="Not now"
                  confirmLabel="Make this the hub"
                  onCancel={() => setPromoting(false)}
                  onConfirm={() => void promote()}
                  restoreFocus={promoteOpener}
                  title="Make this computer the hub for good?"
                >
                  {`${linked.hubName} leaves the roster and this computer becomes the hub. Nothing follows by itself: each other computer's person accepts this one from their own window.`}
                </OctantConfirmDialog>
              )}
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
              {status?.signIn?.spoke.accepting !== true ? null : (
                <div className="settings-panel__stack">
                  <h4 className="settings-section-line">Sign-in requests from the hub</h4>
                  {status.signIn.spoke.requests.length === 0 ? (
                    <SettingsState kind="empty">The hub has asked for nothing.</SettingsState>
                  ) : (
                    <ul aria-label="Sign-in requests from the hub" className="setgroup">
                      {status.signIn.spoke.requests.map((request) => (
                        <li className="setrow" key={request.requestId}>
                          <span className="setrow-label">
                            {`The hub asks you to sign in to your ${signInKindLabel(request.kind)} on this computer`}
                          </span>
                          <p className="setrow-hint">
                            {request.state === "asked"
                              ? `Nothing starts until you accept. Lapses ${request.expiresAt}.`
                              : `${request.guidance ?? ""} Lapses ${request.expiresAt}.`}
                          </p>
                          {request.state === "asked" ? (
                            <OctantButton
                              disabled={busy}
                              onClick={() => void answerSignIn("sign-in-accept", request.requestId)}
                              size="sm"
                              type="button"
                              variant="default"
                            >
                              Accept
                            </OctantButton>
                          ) : (
                            <OctantButton
                              disabled={busy}
                              onClick={() => void answerSignIn("sign-in-check", request.requestId)}
                              size="sm"
                              type="button"
                              variant="default"
                            >
                              Check sign-in
                            </OctantButton>
                          )}
                          <OctantButton
                            disabled={busy}
                            onClick={() => void answerSignIn("sign-in-decline", request.requestId)}
                            size="sm"
                            type="button"
                            variant="secondary"
                          >
                            Decline
                          </OctantButton>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              {status?.provision?.spoke.offering !== true ? null : (
                <div className="settings-panel__stack">
                  <h4 className="settings-section-line">Offers from the hub</h4>
                  {status.provision.spoke.proposals.length === 0 ? (
                    <SettingsState kind="empty">The hub has offered nothing.</SettingsState>
                  ) : (
                    <ul aria-label="Proposals from the hub" className="setgroup">
                      {status.provision.spoke.proposals.map((proposal) => (
                        <li className="setrow" key={proposal.offerId}>
                          <span className="setrow-label">{proposalSummary(proposal.offer)}</span>
                          <p className="setrow-hint">{`Lapses ${proposal.expiresAt}`}</p>
                          {proposal.offer.kind === "routine" ? (
                            <p className="setrow-hint">
                              Apply it with `octant hub apply {proposal.offerId} --project
                              &lt;project-id&gt;`.
                            </p>
                          ) : (
                            <OctantButton
                              disabled={busy}
                              onClick={() => void decideProposal(proposal.offerId, true)}
                              size="sm"
                              type="button"
                              variant="secondary"
                            >
                              Apply
                            </OctantButton>
                          )}
                          <OctantButton
                            disabled={busy}
                            onClick={() => void decideProposal(proposal.offerId, false)}
                            size="sm"
                            type="button"
                            variant="secondary"
                          >
                            Dismiss
                          </OctantButton>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="setgroup">
                    {AUTO_APPLY_KINDS.map((entry) => (
                      <SettingRow
                        description="Apply this kind of offer the moment it arrives, exactly as Apply does and never more. Off by default. A routine and an endpoint always ask."
                        key={entry.kind}
                        label={entry.label}
                        scope="host"
                        settingId={`hub-auto-apply-${entry.kind}`}
                      >
                        <OctantSwitch
                          checked={status.provision?.spoke.autoApply.includes(entry.kind) === true}
                          disabled={busy}
                          label={entry.label}
                          onCheckedChange={(on) => void setAutoApply(entry.kind, on)}
                        />
                      </SettingRow>
                    ))}
                  </div>
                </div>
              )}
              <OctantField>
                <OctantFieldLabel htmlFor={addressId}>
                  Hardware address for Wake-on-LAN (optional)
                </OctantFieldLabel>
                <OctantInput
                  autoComplete="off"
                  id={addressId}
                  onChange={(event) => setAddressDraft(event.target.value)}
                  placeholder="aa:bb:cc:00:11:22"
                  spellCheck={false}
                  value={addressDraft ?? status?.wake?.spoke.hardwareAddress ?? ""}
                />
                <p className="settings-section-line">
                  Stays on this computer unless the hub grant above ticks Wake. Then it goes to the
                  hub so it can send a magic packet on your home network. The hub never learns what
                  your routines do.
                </p>
                <div className="host-settings__controls">
                  <OctantButton
                    disabled={busy || addressDraft === undefined}
                    onClick={() => void saveHardwareAddress(addressDraft?.trim() || null)}
                    size="sm"
                    type="button"
                    variant="secondary"
                  >
                    Save the address
                  </OctantButton>
                </div>
              </OctantField>
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
  const orderRows = field(field(field(hub, "roster"), "roster"), "standbyOrder");
  const standbyOrder = Array.isArray(orderRows)
    ? orderRows.filter((id): id is string => typeof id === "string")
    : [];
  const membership = field(spoke, "membership");
  const hubName = field(field(spoke, "hub"), "name");
  const grant = readGrant(field(spoke, "grant"));
  const wake = readWake(field(body, "wake"));
  const push = readPush(field(body, "push"));
  const provision = readProvision(field(body, "provision"));
  const signIn = readSignIn(field(body, "signIn"));
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
    const standIn = field(spoke, "standIn");
    const startedAt = field(standIn, "startedAt");
    const added = field(standIn, "added");
    const removed = field(standIn, "removed");
    return {
      enabled,
      members,
      owners: readOwners(field(hub, "owners")),
      ownerCandidates: readOwnerCandidates(field(hub, "ownerCandidates")),
      standbyOrder,
      ...(wake === undefined ? {} : { wake }),
      ...(push === undefined ? {} : { push }),
      ...(provision === undefined ? {} : { provision }),
      ...(signIn === undefined ? {} : { signIn }),
      link: {
        membership,
        hubName,
        grant,
        namedStandby: field(spoke, "namedStandby") === true,
        followsStandby: field(spoke, "rosterSignedBy") === "standby",
        ...(typeof startedAt === "number" &&
        typeof added === "number" &&
        typeof removed === "number"
          ? { standIn: { startedAt, added, removed } }
          : {}),
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
    standbyOrder,
    ...(wake === undefined ? {} : { wake }),
    ...(push === undefined ? {} : { push }),
    ...(provision === undefined ? {} : { provision }),
    ...(signIn === undefined ? {} : { signIn }),
  };
}

function readSignIn(value: unknown): SignInView | undefined {
  const rawHub = field(value, "hub");
  const accepting = field(field(value, "spoke"), "accepting");
  const rawRequests = field(field(value, "spoke"), "requests");
  if (!Array.isArray(rawHub) || typeof accepting !== "boolean" || !Array.isArray(rawRequests)) {
    return undefined;
  }
  const hub = rawHub.flatMap((entry: unknown) => {
    const memberId = field(entry, "memberId");
    const kind = field(entry, "kind");
    const result = field(entry, "result");
    const refused = field(result, "refused");
    const word =
      typeof result === "string" ? result : typeof refused === "string" ? `refused:${refused}` : "";
    return typeof memberId === "string" && typeof kind === "string" && word !== ""
      ? [{ memberId, kind, result: word }]
      : [];
  });
  const requests = rawRequests.flatMap((entry: unknown) => {
    const requestId = field(entry, "requestId");
    const kind = field(entry, "kind");
    const state = field(entry, "state");
    const expiresAt = field(entry, "expiresAt");
    const guidance = field(entry, "guidance");
    return typeof requestId === "string" &&
      typeof kind === "string" &&
      (state === "asked" || state === "accepted") &&
      typeof expiresAt === "string"
      ? [
          {
            requestId,
            kind,
            state: state === "accepted" ? ("accepted" as const) : ("asked" as const),
            expiresAt,
            ...(typeof guidance === "string" ? { guidance } : {}),
          },
        ]
      : [];
  });
  return { hub, spoke: { accepting, requests } };
}

function readProvision(value: unknown): ProvisionView | undefined {
  const hub = field(value, "hub");
  const spoke = field(value, "spoke");
  const enabled = field(hub, "enabled");
  const rawOffers = field(hub, "offers");
  const offering = field(spoke, "offering");
  const rawProposals = field(spoke, "proposals");
  if (
    typeof enabled !== "boolean" ||
    !Array.isArray(rawOffers) ||
    typeof offering !== "boolean" ||
    !Array.isArray(rawProposals)
  ) {
    return undefined;
  }
  const offers = rawOffers.flatMap((entry: unknown) => {
    const offerId = field(entry, "offerId");
    const kind = field(entry, "kind");
    const rawDeliveries = field(entry, "deliveries");
    if (typeof offerId !== "string" || typeof kind !== "string" || !Array.isArray(rawDeliveries)) {
      return [];
    }
    const deliveries = rawDeliveries.flatMap((delivery: unknown) => {
      const memberId = field(delivery, "memberId");
      const result = field(delivery, "result");
      const reason = field(delivery, "reason");
      return typeof memberId === "string" && typeof result === "string"
        ? [{ memberId, result, ...(typeof reason === "string" ? { reason } : {}) }]
        : [];
    });
    return [{ offerId, kind, deliveries }];
  });
  const proposals = rawProposals.flatMap((entry: unknown) => {
    const offerId = field(entry, "offerId");
    const expiresAt = field(entry, "expiresAt");
    const offer = readProposalOffer(field(entry, "offer"));
    return typeof offerId === "string" && typeof expiresAt === "string" && offer !== undefined
      ? [{ offerId, offer, expiresAt }]
      : [];
  });
  const autoApply = field(spoke, "autoApply");
  return {
    hub: { enabled, offers },
    spoke: {
      offering,
      autoApply: Array.isArray(autoApply)
        ? autoApply.filter((kind): kind is string => typeof kind === "string")
        : [],
      proposals,
    },
  };
}

function readProposalOffer(value: unknown): ProposalOffer | undefined {
  const kind = field(value, "kind");
  if (
    kind !== "update-channel" &&
    kind !== "plugin" &&
    kind !== "agent-profile" &&
    kind !== "model-endpoint" &&
    kind !== "routine"
  ) {
    return undefined;
  }
  const text = (key: string) => {
    const found = field(value, key);
    return typeof found === "string" ? { [key]: found } : {};
  };
  return {
    kind,
    ...text("channel"),
    ...text("catalogId"),
    ...text("entryId"),
    ...text("displayName"),
    ...text("baseUrl"),
    ...(field(value, "mirror") === true ? { mirror: true } : {}),
  };
}

function readPush(value: unknown): PushView | undefined {
  const hub = field(value, "hub");
  const enabled = field(hub, "enabled");
  const rows = field(hub, "spokes");
  const handing = field(field(value, "spoke"), "handing");
  if (typeof enabled !== "boolean" || !Array.isArray(rows) || typeof handing !== "boolean") {
    return undefined;
  }
  const spokes: Array<PushView["hub"]["spokes"][number]> = [];
  for (const row of rows) {
    const memberId = field(row, "memberId");
    const forwarded = field(row, "forwarded");
    const refused = field(row, "refused");
    const at = field(field(row, "lastResult"), "at");
    const result = field(field(row, "lastResult"), "result");
    if (typeof memberId !== "string" || typeof forwarded !== "number") continue;
    if (typeof refused !== "number") continue;
    spokes.push({
      memberId,
      forwarded,
      refused,
      ...(typeof at === "number" && typeof result === "string"
        ? { lastResult: { at, result } }
        : {}),
    });
  }
  return { hub: { enabled, spokes }, spoke: { handing } };
}

function readWake(value: unknown): WakeView | undefined {
  const hub = field(value, "hub");
  const spoke = field(value, "spoke");
  const enabled = field(hub, "enabled");
  const rows = field(hub, "spokes");
  const sharing = field(spoke, "sharing");
  if (typeof enabled !== "boolean" || !Array.isArray(rows) || typeof sharing !== "boolean") {
    return undefined;
  }
  const spokes: Array<WakeView["hub"]["spokes"][number]> = [];
  for (const row of rows) {
    const memberId = field(row, "memberId");
    const upcoming = field(row, "upcoming");
    const at = field(field(row, "lastResult"), "at");
    const result = field(field(row, "lastResult"), "result");
    if (typeof memberId !== "string" || typeof upcoming !== "number") continue;
    spokes.push({
      memberId,
      upcoming,
      ...(typeof at === "number" && typeof result === "string"
        ? { lastResult: { at, result } }
        : {}),
    });
  }
  const hardwareAddress = field(spoke, "hardwareAddress");
  return {
    hub: { enabled, spokes },
    spoke: { sharing, ...(typeof hardwareAddress === "string" ? { hardwareAddress } : {}) },
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
