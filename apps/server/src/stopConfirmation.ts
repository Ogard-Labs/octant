/**
 * How long a Stop waits for the runtime to confirm the turn ended, in Chat and
 * Code alike: the same grace the renderer gives before it offers Force stop to
 * a runtime that owns its process. A runtime that never answers the interrupt
 * otherwise left the person's Stop waiting indefinitely.
 *
 * What happens at the bound differs by mode and stays with each mode: Chat
 * records a shared-process turn interrupted as a Stop never confirmed, while
 * Code answers the caller and keeps the turn holding its thread until the
 * runtime reports how it ended.
 */
export const STOP_CONFIRMATION_MS = 10_000;
