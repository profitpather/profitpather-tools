/**
 * One distinction, and it is the one that matters when reading the counters:
 * did the caller send something invalid, or did this server fail?
 *
 * Those are opposite signals. "Caller sent a bad country code and got a clear
 * message" is the server working. "The upstream tariff service timed out" is
 * the server failing. Counting both as "errors" is what made the first day of
 * telemetry unreadable: 22 of 246 calls were flagged as errors and 19 of those
 * were a spec-correct method-not-found.
 *
 * Classification is structural, not string matching. Every server funnels its
 * outbound calls through a single helper, so an error raised in there is marked
 * a fault and anything else thrown out of a handler is bad input by definition.
 */

/** Marks an error as this server's fault rather than the caller's. */
export function markFault(err) {
  const e = err instanceof Error ? err : new Error(String(err?.message || err));
  try { e.ppFault = true; } catch { /* frozen error, fall through to the default */ }
  return e;
}

export const isFault = (err) => Boolean(err && err.ppFault === true);

/** Wraps an upstream call so any failure inside it is attributed to us. */
export async function viaUpstream(fn) {
  try {
    return await fn();
  } catch (e) {
    throw markFault(e);
  }
}
