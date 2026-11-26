import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { queueMobileMessage } from "@octant/client-runtime";
import { MOBILE_COPY } from "../copy";
import { createExpoSecureStringStorage } from "../hosts/expoSecureStorage";
import { useMobileThreads } from "../inbox/MobileThreadsContext";
import { useMobileSession } from "../session/MobileSessionContext";
import { waitingFor, type Pairing, type WaitingMessage } from "./outbox";
import { sealedFile } from "./sealedFile";
import { OutboxStore, type OutboxPorts } from "./outboxStore";
import { createSealedText } from "./sealedText";

export interface OutboxApi {
  readonly waitingFor: (
    thread: Pick<WaitingMessage, "hostId" | "mode" | "threadId">,
  ) => ReadonlyArray<WaitingMessage>;
  /** The last change could not be kept on the phone. */
  readonly unsaved: boolean;
  /** Keeps a message for its computer; the reason where it cannot. */
  readonly keep: (message: Omit<WaitingMessage, "pairing">) => string | undefined;
  readonly remove: (id: string) => void;
  readonly tryAgain: (message: WaitingMessage) => void;
}

const Context = createContext<OutboxApi | undefined>(undefined);

export function useOutbox(): OutboxApi {
  const value = useContext(Context);
  if (value === undefined) throw new Error("Messages wait inside OutboxProvider.");
  return value;
}

const PORTS: Pick<OutboxPorts, "now" | "reasons" | "send"> = {
  now: () => new Date(),
  reasons: {
    tooOld: MOBILE_COPY.outboxTooOld,
    otherComputer: MOBILE_COPY.outboxOtherComputer,
    pairedAgain: MOBILE_COPY.outboxPairedAgain,
  },
  send: ({ message, stillWanted, transport }) =>
    queueMobileMessage({
      transport,
      scope: { mode: message.mode, threadId: message.threadId },
      messageId: message.id,
      prompt: message.text,
      stillWanted,
    }),
};

let liveStore: OutboxStore | undefined;
function createLiveStore(): OutboxStore {
  const sealed = createSealedText({
    crypto: globalThis.crypto,
    file: sealedFile("outbox.v1.sealed"),
    keyName: "octant.outbox.key.v1",
    storage: createExpoSecureStringStorage(),
  });
  return new OutboxStore({ ...PORTS, load: sealed.load, keep: sealed.keep });
}

/** The demo's messages are its own, are kept nowhere and sent nowhere. */
function createDemoStore(): OutboxStore {
  return new OutboxStore({
    ...PORTS,
    load: async () => null,
    keep: async () => undefined,
    send: async () => ({ status: "unreachable" }),
  });
}

/**
 * The messages that wait, on screen. This lives behind the app's lock and closes
 * with it, and only while it is open does the store send.
 */
export function OutboxProvider(props: {
  readonly children: ReactNode;
  readonly store?: OutboxStore;
}) {
  const { environment, hosts, hostsLoaded, hostsError, health, transports } = useMobileSession();
  const { refresh } = useMobileThreads();
  const live = environment.kind === "live";
  const [store] = useState(
    () => props.store ?? (live ? (liveStore ??= createLiveStore()) : createDemoStore()),
  );
  const { outbox, unsaved } = useSyncExternalStore(store.subscribe, store.read);
  useEffect(() => store.attach(), [store]);

  const pairings = useMemo(
    () =>
      new Map<string, Pairing>(
        hosts.map(({ hostId, hostKeyFingerprint, keyId }) => [
          hostId,
          { hostKeyFingerprint, keyId },
        ]),
      ),
    [hosts],
  );
  useEffect(() => {
    store.setTargets(
      !live
        ? []
        : transports.flatMap((transport) => {
            const pairing = pairings.get(transport.hostId);
            const ready =
              health.find((entry) => entry.hostId === transport.hostId)?.kind === "ready";
            return pairing === undefined || !ready
              ? []
              : [{ hostId: transport.hostId, pairing, transport }];
          }),
      () => void refresh(),
    );
  }, [health, live, pairings, refresh, store, transports]);
  useEffect(() => {
    // A list that could not be read is not a list without computers.
    if (hostsLoaded && hostsError === undefined)
      store.keepHosts(new Set(hosts.map((host) => host.hostId)));
  }, [hosts, hostsError, hostsLoaded, outbox, store]);

  const value = useMemo<OutboxApi>(
    () => ({
      waitingFor: (thread) => waitingFor(outbox, thread),
      unsaved: unsaved && outbox.messages.length > 0,
      keep: (message) => {
        const pairing = pairings.get(message.hostId);
        if (pairing === undefined) return MOBILE_COPY.outboxNoComputer;
        const status = store.keep({ ...message, pairing });
        return status === "added" ? undefined : MOBILE_COPY.outboxRefusal[status];
      },
      remove: (id) => store.remove(id),
      tryAgain: (message) => store.tryAgain(message.id, pairings.get(message.hostId)),
    }),
    [outbox, pairings, store, unsaved],
  );
  return <Context.Provider value={value}>{props.children}</Context.Provider>;
}
