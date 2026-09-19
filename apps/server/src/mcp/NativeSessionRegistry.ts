import type { ThreadId } from "@t3tools/contracts";

/**
 * The exact session identifier a provider harness gives its own hooks.
 *
 * Claude Agent reports the SDK `session_id`; Codex reports the native thread
 * id it passes to hooks as `session_id`. A consumer that receives one from a
 * Stop hook maps it back to the T3 thread through
 * `GET /api/mcp/provider-session`. The value is stored exactly as the harness
 * gave it and is never trimmed or normalized.
 */

/**
 * One occurrence of a provider session on one thread.
 *
 * An adapter takes an occurrence when it starts a session and quotes it on
 * every later announcement. Occurrence ids are unique for the life of the
 * process, so an announcement from a session that has already been replaced
 * can neither restore its own identifier nor reach another thread.
 */
export interface NativeSessionOccurrence {
  readonly threadId: ThreadId;
  readonly occurrenceId: number;
}

interface NativeSessionRecord {
  readonly occurrenceId: number;
  nativeSessionId: string | undefined;
}

const recordsByThread = new Map<ThreadId, NativeSessionRecord>();
let lastOccurrenceId = 0;

/**
 * Opens a new occurrence for `threadId` and discards whatever the previous
 * occurrence knew. The thread reports no native identifier until the new
 * session announces one.
 */
export function beginNativeSession(threadId: ThreadId): NativeSessionOccurrence {
  lastOccurrenceId += 1;
  const occurrenceId = lastOccurrenceId;
  recordsByThread.set(threadId, { occurrenceId, nativeSessionId: undefined });
  return { threadId, occurrenceId };
}

/**
 * Records the harness identifier for a live occurrence. An announcement that
 * quotes a retired occurrence is ignored.
 */
export function announceNativeSession(
  occurrence: NativeSessionOccurrence,
  nativeSessionId: string,
): void {
  if (nativeSessionId.length === 0) return;
  const record = recordsByThread.get(occurrence.threadId);
  if (record === undefined || record.occurrenceId !== occurrence.occurrenceId) return;
  record.nativeSessionId = nativeSessionId;
}

/**
 * Retires an occurrence. A stop that quotes a retired occurrence leaves the
 * occurrence that replaced it alone.
 */
export function endNativeSession(occurrence: NativeSessionOccurrence): void {
  const record = recordsByThread.get(occurrence.threadId);
  if (record === undefined || record.occurrenceId !== occurrence.occurrenceId) return;
  recordsByThread.delete(occurrence.threadId);
}

/** The identifier of the thread's live provider session, when one is known. */
export function readNativeSessionId(threadId: ThreadId): string | undefined {
  return recordsByThread.get(threadId)?.nativeSessionId;
}

export function clearAllNativeSessions(): void {
  recordsByThread.clear();
}
