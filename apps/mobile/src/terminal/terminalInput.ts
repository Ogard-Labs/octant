import type { TerminalInputModes } from "./terminalScreen";

/** The keys the phone's key row adds above the keyboard, which it has no key for. */
export type TerminalKey = "escape" | "tab" | "up" | "down" | "left" | "right" | "home" | "end";

/** What the shell is sent for a key, in the cursor key mode the program chose. */
export function terminalKeyData(key: TerminalKey, modes: TerminalInputModes): string {
  // A program in application cursor mode (an editor, a pager) reads `ESC O`.
  const cursor = modes.applicationCursorKeys ? "\u001bO" : "\u001b[";
  switch (key) {
    case "escape":
      return "\u001b";
    case "tab":
      return "\t";
    case "up":
      return `${cursor}A`;
    case "down":
      return `${cursor}B`;
    case "right":
      return `${cursor}C`;
    case "left":
      return `${cursor}D`;
    case "home":
      return `${cursor}H`;
    case "end":
      return `${cursor}F`;
  }
}

/**
 * A typed character with Control held: letters and `@[\]^_` become their
 * control codes, `?` becomes DEL, and anything else is sent as typed.
 */
export function controlCharacter(character: string): string {
  const code = character.toUpperCase().charCodeAt(0);
  if (character.length === 1 && code >= 0x40 && code <= 0x5f)
    return String.fromCharCode(code - 0x40);
  if (character === "?") return "\u007f";
  if (character === " ") return "\u0000";
  return character;
}

/**
 * Text that arrived at once, such as a paste, wrapped so a program that asked
 * for bracketed paste does not run it line by line. Line breaks become the
 * Return a shell reads.
 */
export function pastedText(text: string, modes: TerminalInputModes): string {
  const returns = text.replace(/\r?\n/g, "\r");
  return modes.bracketedPaste ? `\u001b[200~${returns}\u001b[201~` : returns;
}
