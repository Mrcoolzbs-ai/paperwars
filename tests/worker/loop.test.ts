import { describe, expect, it, vi } from 'vitest';
import { runTurnWorkerLoop } from '@paper-wars/worker';

describe('runTurnWorkerLoop', () => {
  it('polls an idle queue and processes jobs sequentially until aborted', async () => {
    const controller = new AbortController();
    const waits: number[] = [];
    let processCalls = 0;

    const worker = {
      async processNext() {
        processCalls += 1;
        if (processCalls === 2) {
          return {
            status: 'completed' as const,
            jobId: 'job-1',
            campaignId: 'campaign-1',
            turnNumber: 1,
            nextTurnNumber: 2,
            campaignEnded: false,
            resolution: {} as never,
          };
        }
        return { status: 'idle' as const };
      },
    };

    await runTurnWorkerLoop(worker, {
      signal: controller.signal,
      onError: (error) => {
        throw error;
      },
      idlePollIntervalMs: 25,
      wait: async (milliseconds) => {
        waits.push(milliseconds);
        if (waits.length === 2) controller.abort();
      },
    });

    expect(processCalls).toBe(3);
    expect(waits).toEqual([25, 25]);
  });

  it('reports a transient failure and retries with the error backoff', async () => {
    const controller = new AbortController();
    const failure = new Error('temporary database failure');
    const onError = vi.fn();
    const waits: number[] = [];
    let processCalls = 0;

    const worker = {
      async processNext() {
        processCalls += 1;
        if (processCalls === 1) throw failure;
        return { status: 'idle' as const };
      },
    };

    await runTurnWorkerLoop(worker, {
      signal: controller.signal,
      onError,
      idlePollIntervalMs: 20,
      errorRetryIntervalMs: 80,
      wait: async (milliseconds) => {
        waits.push(milliseconds);
        if (waits.length === 2) controller.abort();
      },
    });

    expect(processCalls).toBe(2);
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(failure);
    expect(waits).toEqual([80, 20]);
  });

  it('does not request a job when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const processNext = vi.fn(async () => ({ status: 'idle' as const }));

    await runTurnWorkerLoop(
      { processNext },
      { signal: controller.signal, onError: () => undefined },
    );

    expect(processNext).not.toHaveBeenCalled();
  });

  it('rejects invalid polling delays before starting the worker', async () => {
    const controller = new AbortController();
    const processNext = vi.fn(async () => ({ status: 'idle' as const }));

    await expect(
      runTurnWorkerLoop(
        { processNext },
        {
          signal: controller.signal,
          onError: () => undefined,
          idlePollIntervalMs: 0,
        },
      ),
    ).rejects.toThrow(/idlePollIntervalMs/);

    expect(processNext).not.toHaveBeenCalled();
  });
});
