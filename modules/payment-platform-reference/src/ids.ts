/**
 * Identity.
 *
 * Article 12 owns the idempotency contract: the caller-chosen operation id,
 * the request fingerprint, and the five decisions. Article 17 owns event
 * identity derived from an aggregate's position. This module owns only the
 * thing neither of them can own alone, because neither of them has both
 * inbound paths: the rule that decides which identity a given effect is keyed
 * on, and the resolution step that joins the two.
 */
import { createHash } from 'node:crypto';

export function sha256(parts: string[]): string {
  const h = createHash('sha256');
  for (const p of parts) {
    h.update(p);
    h.update('\u0000');
  }
  return h.digest('hex');
}

/** Canonical request fingerprint. Article 12 owns the canonicalisation rules. */
export function requestHash(fields: Record<string, string | number>): string {
  const keys = Object.keys(fields).sort();
  return sha256(keys.map((k) => `${k}=${String(fields[k])}`));
}

/**
 * Effect identity on the command path: the caller chose an operation id, and
 * it survives every retry, so it is the identity.
 */
export function commandEffectId(operationId: string, kind: string): string {
  return sha256(['cmd', operationId, kind]);
}

/**
 * Effect identity on the callback path. There is no caller here: the provider
 * generated the event, so no operation id arrives with it, and the event's own
 * id is a field the provider may regenerate on a resend.
 *
 * Stripe's webhook documentation states the consequence directly -- in some
 * cases two separate Event objects are generated and sent, and the way to
 * identify those duplicates is the id of the object in data.object together
 * with the event type. That is the provider-side equivalent of Article 17's
 * rule: reach past the event to the thing that has a position of its own.
 */
export function callbackEffectId(objectId: string, eventType: string): string {
  return sha256(['cb', objectId, eventType]);
}

/**
 * The resolution step. A callback carries a provider object id; the platform
 * keys money on operation ids. Nothing can be applied until the two are
 * joined, and a platform that applies first and joins later has committed to
 * an effect it cannot attribute.
 */
export function resolveOperationId(
  index: ReadonlyMap<string, string>,
  objectId: string,
): string | null {
  return index.get(objectId) ?? null;
}
