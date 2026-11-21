# Worker runtime

## Composition boundary

`apps/worker` is a long-running PostgreSQL-backed process. It owns job polling,
expired-lease reaping, claim renewal, input loading, deterministic RNG construction,
and atomic persistence through `finalizeTurnJob`.

Gameplay rules are supplied by a required adapter module. The adapter exports
`createWorkerAdapter(context)` and returns:

- `loadRuleset(version)`: the immutable, versioned ruleset manifest/definition;
- `resolveTurn(input)`: a resolver that accepts the verified snapshot, finalized
  orders, ruleset and explicit RandomSource, then returns TurnResolution;
- `nextDeadlineAt(claim, resolution)`: the next campaign-local deadline policy.

The adapter must not use global randomness or wall-clock time inside the pure
simulation. A ruleset mismatch or unsupported snapshot schema fails the job and
is routed through the normal retry/reaper path. There is deliberately no default
no-op adapter: a worker must not mark orders as processed without implementing
their mechanics.

## Processing sequence

1. Reap expired claims using database time.
2. Claim one pending job with `FOR UPDATE SKIP LOCKED`; generation is the fencing token.
3. Load campaign metadata, source snapshot, finalized orders and committed seed in
   one `REPEATABLE READ READ ONLY` transaction.
4. Verify the active/live claim, campaign turn and lock state, snapshot version,
   ruleset/RNG/schema versions, and seed commitment.
5. Build the HMAC-backed RandomSource from the verified 32-byte turn seed.
6. Run the adapter resolver while periodically renewing the lease.
7. Renew once more, then atomically persist resolution and final job state.
8. On a processing error, expire only the matching live claim; the Reaper alone
   increments retry_count and decides pending versus failed.

The database remains the queue of record; Redis is not required. The final
fencing UPDATE in persistence is still the authoritative guard against a stale
worker, even when heartbeats are enabled.

## Shutdown and execution constraints

SIGINT/SIGTERM stop new polling. The process waits for the current claim to finish
before closing its PostgreSQL pool. An in-flight resolver is not forcefully
interrupted because the turn must either finish atomically or be recovered by
lease expiry after process termination.

The generic worker accepts an asynchronous resolver adapter, so heartbeats can run
while that adapter yields to the event loop. The current Simulation Engine phase
runner is synchronous; CPU-heavy future rulesets must offload expensive execution
to a Node.js worker thread (or another process) so the host event loop can keep
renewing the lease. The final persistence fence remains mandatory regardless.

## Environment

- `DATABASE_URL`: PostgreSQL connection string.
- `SEED_ENCRYPTION_KEYS` and `SEED_ENCRYPTION_ACTIVE_KEY_VERSION`: versioned seed keys.
- `WORKER_ADAPTER_MODULE`: absolute path to an adapter module exporting
  `createWorkerAdapter(context)`.
- `WORKER_ID`: optional stable process identifier; defaults to hostname + PID.
- `WORKER_IDLE_POLL_MS`: idle/error backoff (default 1000 ms).
- `WORKER_HEARTBEAT_MS`: lease renewal interval (default 60000 ms; maximum 240000 ms).
- `WORKER_REAPER_BATCH_SIZE`: expired jobs processed per poll (default 100).

Never log the plaintext turn seed or serialized RNG context.
