# Setup review digest scheduler validation

Date: 2026-11-04

- The scheduled digest runner was invoked directly with a mock sender against
  a disposable local PostgreSQL restore of host_test.
- A delayed invocation used the original window, 2026-11-03T03:00:00.000Z,
  in its digest key.
- Before the mock send, the stale claim was uncertain and the current
  claim was visible in sending state.
- Repeating the same window was blocked. Exactly one mock receipt persisted.
- The disposable database was removed.
- The 10-minute recovery cutoff was a test fixture. The deployed trigger,
  operational recovery cutoff, and live delivery remain open.
