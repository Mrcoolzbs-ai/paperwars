import type { TurnWorkerResult } from './worker.js';

export interface TurnWorkerLoopOptions {
  /** Aborting stops the loop between jobs; an in-flight job is allowed to finish. */
  readonly signal: AbortSignal;
  /** Called for recoverable processNext failures before the retry delay. */
  readonly onError: (error: unknown) => void;
  /** Delay after processNext reports that no job is available. Defaults to 1 second. */
  readonly idlePollIntervalMs?: number;
  /** Delay after processNext throws. Defaults to 5 seconds. */
  readonly errorRetryIntervalMs?: number;
  /** Injectable delay for deterministic tests or host-specific scheduling. */
  readonly wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export interface TurnWorkerProcess<TEvent> {
  processNext(): Promise<TurnWorkerResult<TEvent>>;
}

const DEFAULT_IDLE_POLL_INTERVAL_MS = 1_000;
const DEFAULT_ERROR_RETRY_INTERVAL_MS = 5_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

function validateDelay(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TIMER_DELAY_MS) {
    throw new RangeError(`${name} must be an integer between 1 and ${MAX_TIMER_DELAY_MS}`);
  }
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();

  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };

    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener('abort', finish, { once: true });

    // Cover an abort that occurs between the initial check and listener setup.
    if (signal.aborted) finish();
  });
}

/**
 * Sequentially drains pending turn jobs.
 *
 * The loop never overlaps turns: it awaits processNext before requesting another
 * job. Idle queues are polled with a bounded delay; transient failures are
 * reported and retried after a separate delay. AbortSignal stops the loop
 * between jobs and interrupts either delay, but does not cancel an in-flight
 * processNext call or its database transaction.
 */
export async function runTurnWorkerLoop<TEvent>(
  worker: TurnWorkerProcess<TEvent>,
  options: TurnWorkerLoopOptions,
): Promise<void> {
  const idlePollIntervalMs = options.idlePollIntervalMs ?? DEFAULT_IDLE_POLL_INTERVAL_MS;
  const errorRetryIntervalMs = options.errorRetryIntervalMs ?? DEFAULT_ERROR_RETRY_INTERVAL_MS;

  validateDelay(idlePollIntervalMs, 'idlePollIntervalMs');
  validateDelay(errorRetryIntervalMs, 'errorRetryIntervalMs');

  const wait = options.wait ?? abortableDelay;
  while (!options.signal.aborted) {
    try {
      const result = await worker.processNext();
      if (result.status === 'idle') {
        await wait(idlePollIntervalMs, options.signal);
      }
    } catch (error) {
      options.onError(error);
      await wait(errorRetryIntervalMs, options.signal);
    }
  }
}
