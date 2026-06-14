# Bun-Native Cached First Refresh Design

## Goal

Agent Lens should feel instant when opened in Coder Workspaces while still making it obvious whether the displayed metrics are cached or fresh. On first load, the dashboard should render the newest persisted snapshot immediately when one exists, start a fresh scan in the background, stream precise progress to the browser, and replace the cached view as soon as fresh aggregates are ready.

The fresh scan itself is part of the work: benchmark it on this machine, identify the slowest scan and aggregation paths, and improve them until the cold path is measurably faster.

## Runtime Direction

The server should become Bun-native rather than an Express app that happens to run on Bun.

- Use `Bun.serve` for HTTP routing and static file serving.
- Prefer Bun runtime APIs where they improve hot paths, especially file reads, JSON reads, SQLite access, and response streaming.
- Keep compatibility only where it is cheap and useful for tests. If runtime behavior depends on Bun, tests and benchmark commands should run under Bun too.
- Avoid adding framework dependencies for routing, SSE, or static serving.

## User Experience

Initial page load should follow this sequence:

1. Browser loads the shell and connects to refresh progress with SSE.
2. API returns cached aggregate data immediately if a persisted snapshot exists.
3. The UI labels the displayed data as cached, shows cache age, and shows that a fresh scan is running.
4. SSE reports agent-level progress: pending, running, done, error, elapsed time, and event counts where available.
5. When the fresh scan completes, the UI fetches or receives the fresh aggregate snapshot, swaps the visible metrics, and labels the data as fresh.
6. Manual refresh forces a new scan and reuses the same visible progress flow.

If no cached snapshot exists, the UI should show skeletons plus live scan progress instead of appearing stuck.

## Server Design

Replace request-time event loading with a snapshot manager:

- `SnapshotManager`
  - Owns the latest event snapshot, aggregate snapshot, persisted snapshot metadata, and current refresh state.
  - Provides cached data immediately when valid persisted data exists.
  - Starts at most one refresh at a time. Concurrent API requests and manual refreshes join or observe the same refresh unless a forced refresh is explicitly newer.
  - Publishes progress updates to SSE subscribers.

- `RefreshProgress`
  - Tracks global state: idle, refreshing, complete, error.
  - Tracks per-agent state: pending, running, done, skipped, error.
  - Records started time, completed time, elapsed time, total event count, per-agent event counts, and error messages.

- `Aggregates`
  - Compute the data used by `/api/history`, `/api/projects`, `/api/tool-calls`, `/api/daily-costs`, and `/api/metrics` once per snapshot.
  - Serve filtered agent views from precomputed aggregate data or cheap filtered projections, not by rescanning adapter files.

## API Design

Keep existing endpoint shapes where practical, but include freshness metadata:

- `/api/bootstrap`
  - Returns agents, cached aggregate snapshot if available, freshness metadata, and current refresh status.
  - Starts background refresh by default.

- `/api/refresh`
  - `POST` starts or joins a refresh.
  - `?force=1` bypasses freshness checks and starts a new scan when possible.

- `/api/refresh-events`
  - SSE endpoint.
  - Sends an initial status event immediately.
  - Sends progress events as each agent starts and completes.
  - Sends a completion event with snapshot metadata when fresh data is ready.

- Existing endpoints
  - Continue to work during migration.
  - Return cached or fresh aggregate data with metadata so the existing UI can be updated incrementally.

## Benchmark Plan

Before optimization, record baseline numbers on this machine:

- cold server startup to `/api/bootstrap`
- cached first paint payload time
- full fresh scan time for all agents
- per-agent scan durations and event counts
- aggregate computation time
- existing multi-endpoint page load fanout timing

Then optimize based on evidence. Likely targets:

- eliminate repeated endpoint aggregation on page load;
- avoid reading adapter data more than once per refresh;
- parallelize independent agent scans with progress events;
- use Bun-native file and SQLite paths in adapters where faster;
- reduce JSON serialization overhead by persisting aggregate snapshots alongside event snapshots.

Benchmarks should be repeatable with scripts and print before/after summaries.

## Testing

Add coverage for:

- cached snapshot returned immediately while refresh is running;
- refresh deduplication across concurrent callers;
- SSE progress event ordering and completion;
- aggregate reuse without repeated adapter scans;
- forced refresh behavior;
- no-cache first load behavior.

Run both functional tests and benchmark scripts before claiming completion.

## Out Of Scope

- Changing pricing formulas.
- Redesigning the dashboard layout beyond visible freshness and progress affordances.
- Perfect token/cost extraction for agents whose local storage does not expose reliable token data.
