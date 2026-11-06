import type {
  BrowserCredentialGrant,
  BrowserCredentialTarget,
} from "@octant/contracts/browser-credential-use";
import { browserProfileKey } from "./browserProfilePolicy";

export const BROWSER_CREDENTIAL_GRANT_MAX_MS = 8 * 60 * 60 * 1000;
export function browserCredentialGrantMatches(
  grant: BrowserCredentialGrant,
  target: BrowserCredentialTarget,
  hostSessionId: string,
  now: number,
): boolean {
  const created = Date.parse(grant.createdAt);
  const expires = Date.parse(grant.expiresAt);
  if (
    !Number.isFinite(created) ||
    !Number.isFinite(expires) ||
    !Number.isFinite(now) ||
    now < created ||
    now >= expires ||
    expires > created + BROWSER_CREDENTIAL_GRANT_MAX_MS ||
    String(grant.hostSessionId) !== hostSessionId ||
    grant.target.mode !== target.mode ||
    String(grant.scope.projectId) !== String(target.projectId) ||
    String(grant.target.projectId) !== String(target.projectId) ||
    browserProfileKey(grant.target.profile) !== browserProfileKey(target.profile) ||
    grant.target.topOrigin !== target.topOrigin ||
    grant.target.frame.kind !== target.frame.kind ||
    grant.target.frame.origin !== target.frame.origin ||
    target.topOrigin !== target.frame.origin ||
    !grant.metadata.websiteOrigins.includes(target.topOrigin)
  )
    return false;
  if (
    target.profile.kind === "project" &&
    String(target.profile.projectId) !== String(target.projectId)
  )
    return false;
  if (target.profile.kind === "private" && grant.scope.kind !== "task") return false;
  return (
    grant.scope.kind === "project" ||
    (String(grant.scope.threadId) === String(target.threadId) &&
      String(grant.scope.contextId) === String(target.contextId))
  );
}
