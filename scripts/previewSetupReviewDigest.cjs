const assert = require("node:assert/strict");
const { setupReviewQueueEligibility } = require("../lib/payments/setupReviewQueueEligibility.ts");
const { Pool } = require("pg");

const classification = `
  CASE
    WHEN status = 'resolved' THEN NULL
    WHEN recorded_at <= as_of - interval '24 hours' THEN 'escalation'
    WHEN assigned_to IS NULL AND recorded_at <= as_of - interval '4 hours'
      THEN 'needs_assignment'
  END
`;

async function checkBoundaries(client) {
  const { rows } = await client.query(`
    WITH fixtures(name, age, assigned_to, status, expected) AS (
      VALUES
        ('just under 4h', interval '4 hours' - interval '1 microsecond',
          NULL, 'unclaimed', NULL),
        ('exactly 4h', interval '4 hours', NULL, 'unclaimed', 'needs_assignment'),
        ('assigned at 4h', interval '4 hours', 'operator', 'in_review', NULL),
        ('just under 24h', interval '24 hours' - interval '1 microsecond',
          NULL, 'unclaimed', 'needs_assignment'),
        ('unassigned at 24h', interval '24 hours', NULL, 'unclaimed', 'escalation'),
        ('assigned at 24h', interval '24 hours', 'operator', 'in_review', 'escalation'),
        ('resolved at 48h', interval '48 hours', 'operator', 'resolved', NULL)
    ), inputs AS (
      SELECT *, transaction_timestamp() AS as_of,
        transaction_timestamp() - age AS recorded_at
      FROM fixtures
    )
    SELECT name, expected, ${classification} AS actual FROM inputs
  `);
  assert.equal(rows.length, 7);
  for (const { name, expected, actual } of rows) {
    assert.equal(actual, expected, name);
  }
  console.log("PASS: 7 digest classification checks.");
}

async function main() {
  const url = new URL(process.env.DATABASE_URL ?? "");
  assert.ok(
    ["postgres:", "postgresql:"].includes(url.protocol) &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
    url.pathname === "/host_test" && !url.search && !url.hash,
    "Expected loopback host_test without URL options."
  );

  const filters = setupReviewQueueEligibility;

  const pool = new Pool({ connectionString: url.toString(), connectionTimeoutMillis: 5000 });
  try {
    const client = await pool.connect();
    try {
      await client.query("BEGIN READ ONLY");
      await client.query("SET LOCAL statement_timeout = '5s'");
      await checkBoundaries(client);

      const { rows } = await client.query(`
        WITH eligible AS (
          SELECT e.id AS review_id, e.object_id AS booking_id,
            e.created_at AS recorded_at, c.assigned_to,
            COALESCE(c.status, 'unclaimed') AS status,
            e.new_state->>'phase' AS phase,
            transaction_timestamp() AS as_of
          ${filters}
        ), classified AS (
          SELECT *, ${classification} AS section FROM eligible
        ), ranked AS (
          SELECT *,
            row_number() OVER (PARTITION BY section ORDER BY recorded_at, review_id) AS position,
            count(*) OVER (PARTITION BY section) AS section_total
          FROM classified
        )
        SELECT section, section_total, review_id, booking_id, phase
        FROM ranked
        WHERE position <= 5
        ORDER BY section NULLS LAST, position
      `);

      const totalFor = section =>
        BigInt(rows.find(row => row.section === section)?.section_total ?? 0);
      const due = totalFor("escalation") + totalFor("needs_assignment");
      const total = due + totalFor(null);
      console.log(`Setup review digest preview | ${due} due of ${total} unresolved`);
      for (const [section, title] of [
        ["escalation", "Escalation"],
        ["needs_assignment", "Needs assignment"],
      ]) {
        const examples = rows.filter(row => row.section === section);
        console.log(`${title}: ${totalFor(section)}`);
        if (examples.length) {
          console.table(examples.map(({ review_id, booking_id, phase }) =>
            ({ review_id, booking_id, phase })
          ));
        }
      }
    } finally {
      try { await client.query("ROLLBACK"); }
      finally { client.release(); }
    }
  } finally {
    await pool.end();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
