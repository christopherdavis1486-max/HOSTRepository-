# Financial queue-health profiling

Prepared: 21 October 2026.

Scope: scheduling-health aggregation only. Financial selection predicates,
queue selection/write transactions, workers and provider operations were not profiled.

## Measurements

| Total metadata rows | Median report ms | EXPLAIN planning ms | EXPLAIN execution ms |
| ---: | ---: | ---: | ---: |
| 0 | 1.936 | 0.241 | 0.094 |
| 1,000 | 2.519 | 0.229 | 0.589 |
| 10,000 | 5.462 | 0.216 | 4.841 |
| 100,000 | 47.576 | 0.217 | 56.881 |

Each scale used equal rows across ten operations, one warmup and three measured
reports. Every report's counts were checked against the deterministic fixture.
The same application report query was captured for EXPLAIN ANALYZE with buffers.
Instrumented EXPLAIN execution and application report timings are separate samples.

Fixtures were temporary tables created from migrations 042-046, with existing
indexes and fresh ANALYZE statistics. Their temporary namespaces were verified.
No persistent scheduling or financial rows were changed. The dedicated fixture
connection was destroyed after profiling.

## Execution-plan observations

The following is extracted from the saved JSON; buffer totals are reported at
the root rather than summed across parent and child nodes.

```json
[
  {
    "totalRows": 0,
    "root": "Aggregate",
    "scans": [
      {
        "relation": "cancellation_settlement_queue_reviews",
        "node": "Seq Scan",
        "rows": 0,
        "loops": 1
      },
      {
        "relation": "new_flow_payment_queue_reviews",
        "node": "Seq Scan",
        "rows": 0,
        "loops": 1
      },
      {
        "relation": "new_flow_refund_queue_reviews",
        "node": "Seq Scan",
        "rows": 0,
        "loops": 1
      },
      {
        "relation": "host_transfer_queue_reviews",
        "node": "Seq Scan",
        "rows": 0,
        "loops": 1
      },
      {
        "relation": "transfer_reversal_queue_reviews",
        "node": "Seq Scan",
        "rows": 0,
        "loops": 1
      }
    ],
    "spillNodes": [],
    "rootLocalHitBlocks": 0,
    "rootTempWrittenBlocks": 0
  },
  {
    "totalRows": 1000,
    "root": "Sort",
    "scans": [
      {
        "relation": "cancellation_settlement_queue_reviews",
        "node": "Seq Scan",
        "rows": 200,
        "loops": 1
      },
      {
        "relation": "new_flow_payment_queue_reviews",
        "node": "Seq Scan",
        "rows": 200,
        "loops": 1
      },
      {
        "relation": "new_flow_refund_queue_reviews",
        "node": "Seq Scan",
        "rows": 200,
        "loops": 1
      },
      {
        "relation": "host_transfer_queue_reviews",
        "node": "Seq Scan",
        "rows": 200,
        "loops": 1
      },
      {
        "relation": "transfer_reversal_queue_reviews",
        "node": "Seq Scan",
        "rows": 200,
        "loops": 1
      }
    ],
    "spillNodes": [],
    "rootLocalHitBlocks": 15,
    "rootTempWrittenBlocks": 0
  },
  {
    "totalRows": 10000,
    "root": "Sort",
    "scans": [
      {
        "relation": "cancellation_settlement_queue_reviews",
        "node": "Seq Scan",
        "rows": 2000,
        "loops": 1
      },
      {
        "relation": "new_flow_payment_queue_reviews",
        "node": "Seq Scan",
        "rows": 2000,
        "loops": 1
      },
      {
        "relation": "new_flow_refund_queue_reviews",
        "node": "Seq Scan",
        "rows": 2000,
        "loops": 1
      },
      {
        "relation": "host_transfer_queue_reviews",
        "node": "Seq Scan",
        "rows": 2000,
        "loops": 1
      },
      {
        "relation": "transfer_reversal_queue_reviews",
        "node": "Seq Scan",
        "rows": 2000,
        "loops": 1
      }
    ],
    "spillNodes": [],
    "rootLocalHitBlocks": 141,
    "rootTempWrittenBlocks": 0
  },
  {
    "totalRows": 100000,
    "root": "Sort",
    "scans": [
      {
        "relation": "cancellation_settlement_queue_reviews",
        "node": "Seq Scan",
        "rows": 20000,
        "loops": 1
      },
      {
        "relation": "new_flow_payment_queue_reviews",
        "node": "Seq Scan",
        "rows": 20000,
        "loops": 1
      },
      {
        "relation": "new_flow_refund_queue_reviews",
        "node": "Seq Scan",
        "rows": 20000,
        "loops": 1
      },
      {
        "relation": "host_transfer_queue_reviews",
        "node": "Seq Scan",
        "rows": 20000,
        "loops": 1
      },
      {
        "relation": "transfer_reversal_queue_reviews",
        "node": "Seq Scan",
        "rows": 20000,
        "loops": 1
      }
    ],
    "spillNodes": [],
    "rootLocalHitBlocks": 0,
    "rootTempWrittenBlocks": 0
  }
]
```

## Interpretation

The report completed at every measured size within its five-second statement
timeout. These observations alone do not justify an index or query change.
The aggregate still examines scheduling metadata as its volume grows.
No production latency target, alert threshold or polling interval is established.

These local synthetic warm-cache samples are not production capacity guarantees
or latency percentiles. Temporary-table storage, isolated execution and balanced
operation counts do not model production concurrency, WAL, skew or cache pressure.
The harness also checks the transaction's read-only setting during report timing.

## Validation and remaining work

Profiling count assertions passed at all four sizes, and TypeScript passed.
The report's prior 25/25 database tests remain recorded in the preceding
queue-health checkpoint; they were not rerun for this profiling-only stage.
All 155 preceding checkpoint files matched before this documentation update.

Financial queue selector profiling, concurrent load, skewed fixtures, monitoring
thresholds, alert delivery and housekeeping remain separate work.
No migrations, index changes, financial gates, environment files, provider
operations, production deployment, commits or normal staging changes.
