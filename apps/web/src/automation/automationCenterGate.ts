/**
 * Release gate for Automation Center navigation.
 *
 * The Automation Center surface, scheduler, dispatcher, and Work first-turn
 * runtime are integrated. Navigation is
 * enabled; the editor catalog is populated from Project / execution /
 * authority profile facts already loaded in App. Code Projects appear only
 * when managed or prepared checkout facts are complete; durable binding
 * receipts are derived from Project/binding/checkout identity rather than
 * inventing incomplete facts.
 */
export const AUTOMATION_CENTER_NAVIGATION_ENABLED = true;
