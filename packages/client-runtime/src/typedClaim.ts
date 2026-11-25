/**
 * Sends a command that claims the person typed its message. A host that
 * predates the claim decodes strictly and refuses the unknown field as an
 * invalid command before it does anything, so the same command goes once more
 * without the claim, which is exactly what an older client sends: the message
 * is delivered and simply not counted as typed.
 */
export async function sendWithTypedClaim<Command extends object, Answer>(
  command: Command,
  send: (command: Command) => Promise<Answer>,
  refusedAsInvalid: (error: unknown) => boolean,
): Promise<Answer> {
  try {
    return await send(command);
  } catch (error) {
    if (!claimsTyped(command) || !refusedAsInvalid(error)) throw error;
    return send(withoutTypedClaim(command));
  }
}

/**
 * The same for a caller that holds the host's answer as a response: a 400 to a
 * body that claims the person typed it is sent once more without the claim.
 */
export async function postWithTypedClaim<Response extends { readonly status: number }>(
  body: object,
  post: (body: object) => Promise<Response>,
): Promise<Response> {
  const response = await post(body);
  if (response.status !== 400 || !claimsTyped(body)) return response;
  return post(withoutTypedClaim(body));
}

function claimsTyped(command: object): boolean {
  if ("typedByPerson" in command && command.typedByPerson === true) return true;
  // A queued message carries its claim inside its payload.
  return "payload" in command && typeof command.payload === "object" && command.payload !== null
    ? claimsTyped(command.payload)
    : false;
}

/** The command with the claim that the person typed it removed, wherever it sits. */
export function withoutTypedClaim<Command extends object>(command: Command): Command {
  const entries = Object.entries(command).filter(([key]) => key !== "typedByPerson");
  const payload = (command as { readonly payload?: unknown }).payload;
  const rest = Object.fromEntries(entries);
  if (typeof payload === "object" && payload !== null && "payload" in rest) {
    rest["payload"] = withoutTypedClaim(payload);
  }
  return rest as Command;
}
