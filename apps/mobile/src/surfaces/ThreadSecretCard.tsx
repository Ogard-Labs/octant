import { useCallback, useMemo, useRef, useState } from "react";
import { Linking, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import {
  answerMobileThreadSecretCard,
  listMobileThreadSecretCards,
  type MobileRemoteTransport,
} from "@octant/client-runtime";
import type {
  ThreadSecretAnswer,
  ThreadSecretFailure,
  ThreadSecretLifetime,
  ThreadSecretRequestCard,
} from "@octant/contracts/thread-secrets";
import { isHoldableSecretValue } from "@octant/domain/secret-guard-policy";
import { useTheme } from "../../design-system";
import { ApprovalDecisionButtons } from "../approvals/ApprovalDecisionButtons";
import { MOBILE_COPY } from "../copy";
import { usePolledResource } from "../runtime/usePolledResource";
import {
  decideWithConfirmation,
  type BiometricAuthenticator,
  type ConfirmedSendResult,
} from "../security/BiometricGate";
import { createExpoBiometricAuthenticator } from "../security/expoBiometricAuthenticator";
import { mobileSpacing, mobileTypography } from "../theme/tokens";

type Card = ThreadSecretRequestCard;
type CardField = Card["fields"][number];

const LIFETIMES: Readonly<Record<ThreadSecretLifetime, string>> = {
  "this-command": "This command",
  "this-turn": "This turn",
  "1-hour": "1 hour",
  "24-hours": "24 hours",
  "until-archived": "Until archived",
  remember: "Remember",
};

const FAILURES: Readonly<Partial<Record<ThreadSecretFailure, string>>> = {
  "not-linked": "1Password answers work only on the computer. Enter the value here instead.",
  "refused-by-strict": "Strict does not allow that. Choose a shorter time.",
  "lifetime-not-offered": "That time is not offered for this secret. Choose another.",
  missing: "Nothing was found there. Enter the value.",
};

export interface ThreadSecretCardsProps {
  readonly transport: MobileRemoteTransport;
  readonly threadId: string;
  readonly refreshIntervalMs?: number;
  /** Confirms Save on this phone; the device's own biometrics when absent. */
  readonly authenticator?: BiometricAuthenticator;
}

/**
 * The secrets a thread's agent waits for, answered from a phone the person
 * paired. What is typed stays in the card until it is sent to the computer.
 * A linked store stays with its person there, so a card offers none here.
 */
export function ThreadSecretCards(props: ThreadSecretCardsProps) {
  const { transport, threadId } = props;
  const load = useCallback(
    () => listMobileThreadSecretCards({ transport, threadId }),
    [transport, threadId],
  );
  const resource = usePolledResource(load, { intervalMs: props.refreshIntervalMs ?? 2_000 });
  const { colors } = useTheme();
  return (
    <>
      {(resource.value ?? []).map((card) =>
        card.state === "pending" || card.state === "saving" ? (
          <SecretCard
            {...props}
            card={card}
            key={card.id}
            onAnswered={() => void resource.reload()}
            stale={resource.error !== undefined}
          />
        ) : (
          <Text
            key={card.id}
            style={[mobileTypography.caption, styles.answered, { color: colors.textSecondary }]}
          >
            {`${card.label} · ${card.state === "saved" ? "Saved securely" : card.state === "declined" ? "Declined" : "Closed"}`}
          </Text>
        ),
      )}
    </>
  );
}

function SecretCard(
  props: ThreadSecretCardsProps & {
    readonly card: Card;
    readonly onAnswered: () => void;
    readonly stale: boolean;
  },
) {
  const { card, transport, threadId } = props;
  const { colors } = useTheme();
  const deviceAuthenticator = useMemo(() => createExpoBiometricAuthenticator(), []);
  const authenticator = props.authenticator ?? deviceAuthenticator;
  const [values, setValues] = useState<Readonly<Record<string, string>>>({});
  const [remembered, setRemembered] = useState<Readonly<Record<string, string>>>({});
  const [shown, setShown] = useState<Readonly<Record<string, boolean>>>({});
  const [lifetime, setLifetime] = useState(card.defaultLifetime);
  const [sending, setSending] = useState(false);
  const inFlight = useRef(false);
  const [note, setNote] = useState<string>();
  const busy = sending || card.state === "saving";
  const multiple = card.fields.length > 1 || card.fields[0]?.name !== card.name;

  const complete = card.fields.every(
    ({ name }) => remembered[name] !== undefined || (values[name] ?? "").trim() !== "",
  );
  const tooPlain = card.fields.some(({ name, secret }) => {
    const value = values[name] ?? "";
    return (
      secret &&
      remembered[name] === undefined &&
      value.trim() !== "" &&
      !isHoldableSecretValue(value)
    );
  });

  const send = async (answer: ThreadSecretAnswer) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSending(true);
    setNote(undefined);
    try {
      const deliver = () => answerMobileThreadSecretCard({ transport, threadId, answer });
      // Declining is the safe direction, so only Save asks for confirmation.
      const outcome: ConfirmedSendResult<Awaited<ReturnType<typeof deliver>>> =
        answer.action === "decline"
          ? { status: "sent", value: await deliver() }
          : await decideWithConfirmation({ authenticator, reason: "approve", send: deliver });
      if (outcome.status === "blocked") {
        setNote(outcome.message);
        return;
      }
      const reply = outcome.value;
      if (reply.status === "refused") {
        setNote(FAILURES[reply.failure] ?? "The computer could not save it. Try again.");
      } else if (reply.status === "not-taken") {
        setNote("The computer did not take that. Try again.");
      } else {
        setValues({});
      }
    } catch {
      // It may have arrived: what was typed is not sent a second time.
      setValues({});
      setNote("The result is not known. What you entered was cleared and is not sent again.");
    } finally {
      inFlight.current = false;
      setSending(false);
      props.onAnswered();
    }
  };

  const save = () =>
    void send({
      id: card.id,
      action: "save",
      lifetime,
      fields: card.fields.map(({ name }) => {
        const rememberedId = remembered[name];
        return rememberedId === undefined
          ? // Exactly as typed: spaces in a password matter.
            { name, source: "pasted", value: values[name] ?? "" }
          : { name, source: "remembered", rememberedId };
      }),
    });

  const caption = [mobileTypography.caption, { color: colors.textSecondary }];
  const { url } = card;
  return (
    <View style={[styles.card, { borderColor: colors.border }]} testID="mobile-thread-secret-card">
      <Text style={[mobileTypography.section, { color: colors.textPrimary }]}>{card.label}</Text>
      <Text style={[mobileTypography.body, { color: colors.textPrimary }]}>{card.reason}</Text>
      {url === undefined ? null : (
        <Pressable
          accessibilityRole="link"
          hitSlop={8}
          onPress={() => void Linking.openURL(url).catch(() => undefined)}
          style={styles.choice}
        >
          <Text style={[mobileTypography.body, { color: colors.accent }]}>
            Open {new URL(url).host}
          </Text>
          <Text style={caption}>{url}</Text>
        </Pressable>
      )}
      {card.fields.map((field) => {
        const offered = rememberedFor(card, field);
        const chosen = remembered[field.name];
        const visible = !field.secret || shown[field.name] === true;
        return (
          <View key={field.name} style={styles.field}>
            {multiple ? <Text style={caption}>{field.label}</Text> : null}
            {offered.length === 0 ? null : (
              <View accessibilityRole="radiogroup" style={styles.choices}>
                <Choice
                  disabled={busy}
                  label="Enter it"
                  onPress={() => setRemembered((now) => without(now, field.name))}
                  selected={chosen === undefined}
                />
                {offered.map((entry) => (
                  <Choice
                    disabled={busy}
                    key={entry.id}
                    label={`Remembered ${entry.name}`}
                    onPress={() => {
                      setValues((now) => without(now, field.name));
                      setRemembered((now) => ({ ...now, [field.name]: entry.id }));
                    }}
                    selected={chosen === entry.id}
                  />
                ))}
              </View>
            )}
            {chosen === undefined ? (
              <View style={[styles.row, { borderColor: colors.border }]}>
                <TextInput
                  accessibilityLabel={field.label}
                  autoCapitalize="none"
                  autoComplete="off"
                  autoCorrect={false}
                  editable={!busy}
                  maxLength={4096}
                  onChangeText={(value) => {
                    setNote(undefined);
                    setValues((now) => ({ ...now, [field.name]: value }));
                  }}
                  placeholder={field.placeholder}
                  placeholderTextColor={colors.textSecondary}
                  secureTextEntry={!visible}
                  spellCheck={false}
                  style={[styles.input, mobileTypography.body, { color: colors.textPrimary }]}
                  textContentType="none"
                  value={values[field.name] ?? ""}
                />
                {field.secret ? (
                  <Pressable
                    accessibilityLabel={`Show ${field.label}`}
                    accessibilityRole="switch"
                    accessibilityState={{ checked: visible, disabled: busy }}
                    disabled={busy}
                    hitSlop={8}
                    onPress={() =>
                      setShown((now) => ({ ...now, [field.name]: now[field.name] !== true }))
                    }
                    style={styles.show}
                  >
                    <Text style={caption}>{visible ? "Hide" : "Show"}</Text>
                  </Pressable>
                ) : null}
              </View>
            ) : null}
          </View>
        );
      })}
      {card.kind === "account-password" ? (
        <Text style={[mobileTypography.caption, { color: colors.textPrimary }]}>
          An account password unlocks that whole computer, not only what the agent asked for.
        </Text>
      ) : null}
      {tooPlain ? (
        <Text style={caption}>
          Too short to hide if a command prints it. A longer value is hidden.
        </Text>
      ) : null}
      <Text style={caption}>Keep for</Text>
      <View accessibilityRole="radiogroup" style={styles.choices}>
        {card.lifetimes.map((value) => (
          <Choice
            disabled={busy}
            key={value}
            label={LIFETIMES[value]}
            onPress={() => setLifetime(value)}
            selected={lifetime === value}
          />
        ))}
      </View>
      <Text style={caption}>
        {card.delivery === "handle"
          ? "Kept out of chat. Only an Octant tool can use it."
          : "Kept out of chat. Commands in this thread can read it while it lasts."}
      </Text>
      <ApprovalDecisionButtons
        allowDisabled={!complete}
        allowLabel="Save securely"
        busy={busy}
        denyLabel="Decline"
        onAllow={save}
        onDeny={() => void send({ id: card.id, action: "decline" })}
      />
      {props.stale || note !== undefined ? (
        <Text accessibilityLiveRegion="polite" style={caption}>
          {note ?? MOBILE_COPY.approvalReconnecting}
        </Text>
      ) : null}
    </View>
  );
}

function Choice(props: {
  readonly label: string;
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: props.selected, disabled: props.disabled }}
      disabled={props.disabled}
      hitSlop={4}
      onPress={props.onPress}
      style={[styles.chip, { borderColor: props.selected ? colors.textPrimary : colors.border }]}
    >
      <Text
        style={[
          mobileTypography.caption,
          { color: props.selected ? colors.textPrimary : colors.textSecondary },
        ]}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

/** The names a card's fields were saved under carry the request's, unless it has one unnamed value. */
function rememberedFor(card: Card, field: CardField): Card["remembered"] {
  const name = field.name === card.name ? card.name : `${card.name}_${field.name}`;
  return card.remembered.filter((entry) => entry.name === name);
}

function without<T>(record: Readonly<Record<string, T>>, key: string): Readonly<Record<string, T>> {
  const { [key]: _removed, ...rest } = record;
  return rest;
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: mobileSpacing.md,
    marginBottom: mobileSpacing.sm,
    padding: mobileSpacing.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    gap: mobileSpacing.xs,
  },
  answered: { marginHorizontal: mobileSpacing.md, marginBottom: mobileSpacing.sm },
  choice: { minHeight: 44, justifyContent: "center" },
  field: { gap: mobileSpacing.xs },
  row: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
  },
  input: { flex: 1, minHeight: 44, paddingHorizontal: mobileSpacing.sm },
  show: {
    minHeight: 44,
    minWidth: 44,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: mobileSpacing.sm,
  },
  choices: { flexDirection: "row", flexWrap: "wrap", gap: mobileSpacing.xs },
  chip: {
    minHeight: 36,
    justifyContent: "center",
    paddingHorizontal: mobileSpacing.sm,
    borderWidth: 1,
    borderRadius: 18,
  },
});
