// Reconnect and retry backoff per contracts 9.2: 1 s, 2 s, 3 s, 5 s, then 5 s
// forever. The service never gives up.

export const BACKOFF_MS: readonly number[] = [1000, 2000, 3000, 5000];

export function backoffMs(attempt: number): number {
  const i = Math.min(Math.max(attempt, 0), BACKOFF_MS.length - 1);
  return BACKOFF_MS[i] as number;
}

// The first retry after a join-denied waits 10 s (contracts 9.2, 2.3 step 8).
export const JOIN_DENIED_FIRST_WAIT_MS = 10_000;
