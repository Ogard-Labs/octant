import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AppState } from "react-native";
import {
  askRemoteSessionStanding,
  type MobileInboxRow,
  type RemoteSessionStanding,
} from "@octant/client-runtime";
import { useMobileThreads } from "../inbox/MobileThreadsContext";
import { enteredMobileForeground } from "../inbox/threadRefreshPolicy";
import type { PendingAttachment } from "../inbox/thread/pendingAttachments";
import { useMobileSession } from "../session/MobileSessionContext";
import { mobileShareStagingFs } from "./mobileShareStaging";
import { SendToSheet } from "./SendToSheet";
import type { ShareBotRow } from "./shareDestinations";
import { discardStagedShare, loadAndSweepStagedShares } from "./shareStagingStore";
import type { ShareStagingFs, ValidatedStagedShare } from "./shareValidation";

export interface PendingThreadShareHandoff {
  readonly shareId: string;
  readonly hostId: string;
  readonly mode: "chat" | "work" | "code";
  readonly threadId: string;
  readonly text: string;
  readonly attachments: ReadonlyArray<PendingAttachment>;
}

export interface ShareContextValue {
  /** Bumps whenever a new thread share handoff arrives, even if that thread is already open. */
  readonly handoffVersion: number;
  /** Consumes a pending share handoff targeted at the currently open thread. */
  readonly takeThreadHandoff: (thread: {
    readonly hostId: string;
    readonly mode: "chat" | "work" | "code";
    readonly threadId: string;
  }) => PendingThreadShareHandoff | undefined;
  /** Deletes the staged share on disk once the person taps Send and it succeeds. */
  readonly completeStagedShare: (shareId: string) => void;
  /** Releases an unsent composer reservation when the thread composer closes so staged items reappear. */
  readonly releaseStagedShare: (shareId: string) => void;
  /** Notice about a malformed or tampered staged share that was swept and removed. */
  readonly stagingNotice: string | undefined;
  readonly dismissStagingNotice: () => void;
}

const NOOP_CONTEXT: ShareContextValue = {
  handoffVersion: 0,
  takeThreadHandoff: () => undefined,
  completeStagedShare: () => undefined,
  releaseStagedShare: () => undefined,
  stagingNotice: undefined,
  dismissStagingNotice: () => undefined,
};

const ShareContext = createContext<ShareContextValue>(NOOP_CONTEXT);

export function useMobileShare(): ShareContextValue {
  return useContext(ShareContext);
}

/**
 * Coordinates incoming OS shares behind AppVaultGate over MobileSessionContext.
 * Reads and sweeps staged shares at launch, on foreground return, and on
 * `octant://share`, then presents the "Send to…" sheet.
 */
export function ShareProvider(props: {
  readonly children: ReactNode;
  readonly pendingShareSignal?: number | undefined;
  readonly onShareSignalConsumed?: (() => void) | undefined;
  readonly onOpenThread: (row: MobileInboxRow) => void;
  readonly bots?: ReadonlyArray<ShareBotRow> | undefined;
  readonly fs?: ShareStagingFs | undefined;
}) {
  const { environment, hosts, hostsLoaded, transports } = useMobileSession();
  const { rows, projectName, lastStanding, noteStanding, refresh } = useMobileThreads();
  const fs = props.fs ?? mobileShareStagingFs;
  const live = environment.kind === "live";

  const [stagedShares, setStagedShares] = useState<ReadonlyArray<ValidatedStagedShare>>([]);
  const [stagingNotice, setStagingNotice] = useState<string | undefined>();
  const [pendingHandoff, setPendingHandoff] = useState<PendingThreadShareHandoff | undefined>();
  const [handoffVersion, setHandoffVersion] = useState(0);
  const [liveStandings, setLiveStandings] = useState<ReadonlyMap<string, RemoteSessionStanding>>(
    new Map(),
  );
  // Shares already loaded into an open thread's composer waiting for the person to tap Send.
  const inComposerRef = useRef<Set<string>>(new Set());

  const inspectStaging = useCallback(async () => {
    if (!live || !fs.available) return;
    const loaded = await loadAndSweepStagedShares(fs, Date.now());
    setStagedShares(loaded.shares.filter((share) => !inComposerRef.current.has(share.id)));
    if (loaded.notices[0] !== undefined) {
      setStagingNotice(loaded.notices[0]);
    }
  }, [fs, live]);

  // Launch sweep & intake.
  useEffect(() => {
    if (!live || !hostsLoaded) return;
    void inspectStaging();
  }, [hostsLoaded, inspectStaging, live]);

  // Foreground sweep & intake (iOS share extension returns here after saving).
  useEffect(() => {
    if (!live) return;
    let previous = AppState.currentState ?? null;
    const subscription = AppState.addEventListener("change", (next) => {
      const returned = enteredMobileForeground(previous, next);
      previous = next;
      if (returned) {
        void inspectStaging();
      }
    });
    return () => subscription.remove();
  }, [inspectStaging, live]);

  // Android `octant://share` bare deep link signal.
  const { pendingShareSignal, onShareSignalConsumed } = props;
  useEffect(() => {
    if (!live || pendingShareSignal === undefined) return;
    void inspectStaging();
    onShareSignalConsumed?.();
  }, [inspectStaging, live, onShareSignalConsumed, pendingShareSignal]);

  const activeShare = stagedShares[0];
  // Ask each connected computer's live standing while "Send to…" is open so
  // restricted/watching-only hosts are disabled honestly.
  useEffect(() => {
    if (activeShare === undefined) return;
    let cancelled = false;
    void Promise.all(
      transports.map(async (transport) => {
        const asked = await askRemoteSessionStanding(transport).catch(() => ({
          answered: false as const,
          standing: undefined,
        }));
        if (asked.answered && asked.standing !== undefined) {
          noteStanding(transport.hostId, asked.standing);
          return [transport.hostId, asked.standing] as const;
        }
        return undefined;
      }),
    ).then((entries) => {
      if (cancelled) return;
      const valid = entries.filter((entry) => entry !== undefined);
      setLiveStandings(new Map(valid));
    });
    return () => {
      cancelled = true;
    };
  }, [activeShare, noteStanding, transports]);

  const standingForHost = useCallback(
    (hostId: string) => liveStandings.get(hostId) ?? lastStanding(hostId),
    [lastStanding, liveStandings],
  );

  const handleDiscard = useCallback(
    (shareId: string) => {
      inComposerRef.current.delete(shareId);
      setStagedShares((current) => current.filter((item) => item.id !== shareId));
      void discardStagedShare(fs, shareId);
    },
    [fs],
  );

  const completeStagedShare = useCallback(
    (shareId: string) => {
      inComposerRef.current.delete(shareId);
      setStagedShares((current) => current.filter((item) => item.id !== shareId));
      void discardStagedShare(fs, shareId);
    },
    [fs],
  );

  const releaseStagedShare = useCallback(
    (shareId: string) => {
      if (!inComposerRef.current.delete(shareId)) return;
      if (pendingHandoffRef.current?.shareId === shareId) {
        pendingHandoffRef.current = undefined;
        setPendingHandoff(undefined);
      }
      void inspectStaging();
    },
    [inspectStaging],
  );

  const handleNewChatSent = useCallback(
    (shareId: string, row: MobileInboxRow) => {
      completeStagedShare(shareId);
      void refresh();
      props.onOpenThread(row);
    },
    [completeStagedShare, props, refresh],
  );

  const handlePopulateThread = useCallback(
    (handoff: {
      readonly shareId: string;
      readonly row: MobileInboxRow;
      readonly text: string;
      readonly attachments: ReadonlyArray<PendingAttachment>;
    }) => {
      inComposerRef.current.add(handoff.shareId);
      setStagedShares((current) => current.filter((item) => item.id !== handoff.shareId));
      setPendingHandoff({
        shareId: handoff.shareId,
        hostId: handoff.row.hostId,
        mode: handoff.row.mode,
        threadId: handoff.row.threadId,
        text: handoff.text,
        attachments: handoff.attachments,
      });
      setHandoffVersion((version) => version + 1);
      props.onOpenThread(handoff.row);
    },
    [props],
  );

  const pendingHandoffRef = useRef(pendingHandoff);
  pendingHandoffRef.current = pendingHandoff;

  const takeThreadHandoff = useCallback(
    (thread: {
      readonly hostId: string;
      readonly mode: "chat" | "work" | "code";
      readonly threadId: string;
    }) => {
      const current = pendingHandoffRef.current;
      if (
        current === undefined ||
        current.hostId !== thread.hostId ||
        current.mode !== thread.mode ||
        current.threadId !== thread.threadId
      ) {
        return undefined;
      }
      pendingHandoffRef.current = undefined;
      setPendingHandoff(undefined);
      return current;
    },
    [],
  );

  // If the last computer is removed while a share is open, clear staged shares.
  useEffect(() => {
    if (live && hostsLoaded && hosts.length === 0 && stagedShares.length > 0) {
      inComposerRef.current.clear();
      setStagedShares([]);
      void fs.deleteAllShares();
    }
  }, [fs, hosts.length, hostsLoaded, live, stagedShares.length]);

  const value = useMemo<ShareContextValue>(
    () => ({
      handoffVersion,
      takeThreadHandoff,
      completeStagedShare,
      releaseStagedShare,
      stagingNotice,
      dismissStagingNotice: () => setStagingNotice(undefined),
    }),
    [completeStagedShare, handoffVersion, releaseStagedShare, stagingNotice, takeThreadHandoff],
  );

  return (
    <ShareContext.Provider value={value}>
      {props.children}
      {live && activeShare !== undefined ? (
        <SendToSheet
          bots={props.bots}
          onDiscard={handleDiscard}
          onNewChatSent={handleNewChatSent}
          onPopulateThread={handlePopulateThread}
          projectName={projectName}
          rows={rows}
          share={activeShare}
          standingForHost={standingForHost}
        />
      ) : null}
    </ShareContext.Provider>
  );
}
