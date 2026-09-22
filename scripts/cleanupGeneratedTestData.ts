import { Pool, PoolClient } from "pg";

const GENERATED_EMAIL_PATTERN = "%@test.host";
const EXPECTED_GENERATED_USERS = 7_943;
const PRODUCTION_DATABASE_HOST =
  "ep-solitary-smoke-zav2shpw-pooler.c-2.eu-west-2.aws.neon.tech";
const EXECUTION_CONFIRMATION =
  "DELETE_7943_GENERATED_TEST_USERS";

type DeleteStep = {
  table: string;
  sql: string;
};

const deleteSteps: DeleteStep[] = [
  {
    table: "host_transfer_reversals",
    sql: `DELETE FROM host_transfer_reversals
          WHERE entitlement_id IN (
            SELECT id FROM cleanup_entitlements
          )`,
  },
  {
    table: "refunds",
    sql: `DELETE FROM refunds
          WHERE booking_id IN (SELECT id FROM cleanup_bookings)
             OR payment_id IN (SELECT id FROM cleanup_payments)`,
  },
  {
    table: "disputes",
    sql: `DELETE FROM disputes
          WHERE booking_id IN (SELECT id FROM cleanup_bookings)
             OR payment_id IN (SELECT id FROM cleanup_payments)`,
  },
  {
    table: "messages",
    sql: `DELETE FROM messages
          WHERE conversation_id IN (
            SELECT id FROM cleanup_conversations
          )
             OR sender_user_id IN (
               SELECT id FROM cleanup_users
             )`,
  },
  {
    table: "reviews",
    sql: `DELETE FROM reviews
          WHERE booking_id IN (SELECT id FROM cleanup_bookings)
             OR property_id IN (SELECT id FROM cleanup_properties)
             OR guest_id IN (SELECT id FROM cleanup_users)`,
  },
  {
    table: "saved_properties",
    sql: `DELETE FROM saved_properties
          WHERE user_id IN (SELECT id FROM cleanup_users)
             OR property_id IN (SELECT id FROM cleanup_properties)`,
  },
  {
    table: "payment_attempts",
    sql: `DELETE FROM payment_attempts
          WHERE booking_id IN (SELECT id FROM cleanup_bookings)`,
  },
  {
    table: "payouts",
    sql: `DELETE FROM payouts
          WHERE booking_id IN (SELECT id FROM cleanup_bookings)
             OR host_id IN (SELECT id FROM cleanup_hosts)`,
  },
  {
    table: "ledger_entries",
    sql: `DELETE FROM ledger_entries
          WHERE booking_id IN (SELECT id FROM cleanup_bookings)
             OR property_id IN (SELECT id FROM cleanup_properties)
             OR host_id IN (SELECT id FROM cleanup_hosts)`,
  },
  {
    table: "host_transfer_entitlements",
    sql: `DELETE FROM host_transfer_entitlements
          WHERE id IN (SELECT id FROM cleanup_entitlements)`,
  },
  {
    table: "payments",
    sql: `DELETE FROM payments
          WHERE id IN (SELECT id FROM cleanup_payments)`,
  },
  {
    table: "conversations",
    sql: `DELETE FROM conversations
          WHERE id IN (SELECT id FROM cleanup_conversations)`,
  },
  {
    table: "booking_guests",
    sql: `DELETE FROM booking_guests
          WHERE booking_id IN (SELECT id FROM cleanup_bookings)`,
  },
  {
    table: "booking_price_components",
    sql: `DELETE FROM booking_price_components
          WHERE booking_id IN (SELECT id FROM cleanup_bookings)`,
  },
  {
    table: "bookings",
    sql: `DELETE FROM bookings
          WHERE id IN (SELECT id FROM cleanup_bookings)`,
  },
  {
    table: "properties",
    sql: `DELETE FROM properties
          WHERE id IN (SELECT id FROM cleanup_properties)`,
  },
  {
    table: "notifications",
    sql: `DELETE FROM notifications
          WHERE user_id IN (SELECT id FROM cleanup_users)`,
  },
  {
    table: "notification_preferences",
    sql: `DELETE FROM notification_preferences
          WHERE user_id IN (SELECT id FROM cleanup_users)`,
  },
  {
    table: "password_reset_tokens",
    sql: `DELETE FROM password_reset_tokens
          WHERE user_id IN (SELECT id FROM cleanup_users)`,
  },
  {
    table: "privacy_requests",
    sql: `DELETE FROM privacy_requests
          WHERE user_id IN (SELECT id FROM cleanup_users)`,
  },
  {
    table: "verifications",
    sql: `DELETE FROM verifications
          WHERE user_id IN (SELECT id FROM cleanup_users)`,
  },
  {
    table: "guest_profiles",
    sql: `DELETE FROM guest_profiles
          WHERE user_id IN (SELECT id FROM cleanup_users)`,
  },
  {
    table: "host_profiles",
    sql: `DELETE FROM host_profiles
          WHERE id IN (SELECT id FROM cleanup_hosts)`,
  },
  {
    table: "users",
    sql: `DELETE FROM users
          WHERE id IN (SELECT id FROM cleanup_users)`,
  },
];

async function createCleanupSets(client: PoolClient) {
  await client.query(`
    CREATE TEMP TABLE cleanup_users
    ON COMMIT DROP
    AS
    SELECT id
    FROM users
    WHERE LOWER(email) LIKE '${GENERATED_EMAIL_PATTERN}';

    CREATE UNIQUE INDEX cleanup_users_id_idx
      ON cleanup_users(id);

    CREATE TEMP TABLE cleanup_hosts
    ON COMMIT DROP
    AS
    SELECT id
    FROM host_profiles
    WHERE user_id IN (SELECT id FROM cleanup_users);

    CREATE UNIQUE INDEX cleanup_hosts_id_idx
      ON cleanup_hosts(id);

    CREATE TEMP TABLE cleanup_properties
    ON COMMIT DROP
    AS
    SELECT id
    FROM properties
    WHERE host_id IN (SELECT id FROM cleanup_hosts);

    CREATE UNIQUE INDEX cleanup_properties_id_idx
      ON cleanup_properties(id);

    CREATE TEMP TABLE cleanup_bookings
    ON COMMIT DROP
    AS
    SELECT id
    FROM bookings
    WHERE guest_id IN (SELECT id FROM cleanup_users)
       OR host_id IN (SELECT id FROM cleanup_hosts)
       OR property_id IN (SELECT id FROM cleanup_properties);

    CREATE UNIQUE INDEX cleanup_bookings_id_idx
      ON cleanup_bookings(id);

    CREATE TEMP TABLE cleanup_payments
    ON COMMIT DROP
    AS
    SELECT id
    FROM payments
    WHERE booking_id IN (SELECT id FROM cleanup_bookings);

    CREATE UNIQUE INDEX cleanup_payments_id_idx
      ON cleanup_payments(id);

    CREATE TEMP TABLE cleanup_conversations
    ON COMMIT DROP
    AS
    SELECT id
    FROM conversations
    WHERE booking_id IN (SELECT id FROM cleanup_bookings)
       OR guest_id IN (SELECT id FROM cleanup_users)
       OR host_id IN (SELECT id FROM cleanup_hosts)
       OR property_id IN (SELECT id FROM cleanup_properties);

    CREATE UNIQUE INDEX cleanup_conversations_id_idx
      ON cleanup_conversations(id);

    CREATE TEMP TABLE cleanup_entitlements
    ON COMMIT DROP
    AS
    SELECT id
    FROM host_transfer_entitlements
    WHERE booking_id IN (SELECT id FROM cleanup_bookings)
       OR host_id IN (SELECT id FROM cleanup_hosts);

    CREATE UNIQUE INDEX cleanup_entitlements_id_idx
      ON cleanup_entitlements(id);
  `);
}

async function assertSafeBoundary(client: PoolClient) {
  const population = await client.query<{
    users: number;
    hosts: number;
    properties: number;
    bookings: number;
  }>(`
    SELECT
      (SELECT COUNT(*)::int FROM cleanup_users) AS users,
      (SELECT COUNT(*)::int FROM cleanup_hosts) AS hosts,
      (SELECT COUNT(*)::int FROM cleanup_properties) AS properties,
      (SELECT COUNT(*)::int FROM cleanup_bookings) AS bookings
  `);

  const summary = population.rows[0];

  console.log("Cleanup candidate population:");
  console.table([summary]);

  if (summary.users !== EXPECTED_GENERATED_USERS) {
    throw new Error(
      `Stopped: expected ${EXPECTED_GENERATED_USERS} generated users, found ${summary.users}.`,
    );
  }

  const blockers = await client.query<{
    check_name: string;
    rows: number;
  }>(`
    SELECT *
    FROM (
      SELECT 'admin_roles' AS check_name, COUNT(*)::int AS rows
      FROM admin_roles
      WHERE user_id IN (SELECT id FROM cleanup_users)
         OR granted_by IN (SELECT id FROM cleanup_users)
         OR disabled_by IN (SELECT id FROM cleanup_users)

      UNION ALL

      SELECT 'admin_security_actions', COUNT(*)::int
      FROM admin_security_actions
      WHERE actor_user_id IN (SELECT id FROM cleanup_users)
         OR target_user_id IN (SELECT id FROM cleanup_users)

      UNION ALL

      SELECT 'audit_log', COUNT(*)::int
      FROM audit_log
      WHERE actor_user_id IN (SELECT id FROM cleanup_users)

      UNION ALL

      SELECT 'preserved_bookings',
             COUNT(*)::int
      FROM bookings
      WHERE id NOT IN (SELECT id FROM cleanup_bookings)
        AND (
          guest_id IN (SELECT id FROM cleanup_users)
          OR host_id IN (SELECT id FROM cleanup_hosts)
          OR property_id IN (SELECT id FROM cleanup_properties)
        )

      UNION ALL

      SELECT 'preserved_properties_with_test_approver',
             COUNT(*)::int
      FROM properties
      WHERE id NOT IN (SELECT id FROM cleanup_properties)
        AND compliance_approved_by IN (
          SELECT id FROM cleanup_users
        )

      UNION ALL

      SELECT 'preserved_compliance_items_with_test_reviewer',
             COUNT(*)::int
      FROM property_compliance_items
      WHERE property_id NOT IN (
        SELECT id FROM cleanup_properties
      )
        AND reviewed_by IN (SELECT id FROM cleanup_users)
    ) checks
    ORDER BY check_name
  `);

  console.log("Safety boundary checks:");
  console.table(blockers.rows);

  const blocked = blockers.rows.filter((row) => row.rows !== 0);

  if (blocked.length > 0) {
    throw new Error(
      "Stopped: generated identities cross the protected data boundary.",
    );
  }
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not configured.");
  }

  const parsed = new URL(databaseUrl);
  const execute = process.argv.includes("--execute");

  if (execute) {
    if (parsed.hostname !== PRODUCTION_DATABASE_HOST) {
      throw new Error(
        `Execution blocked: unexpected database host ${parsed.hostname}.`,
      );
    }

    if (
      process.env.CONFIRM_GENERATED_TEST_CLEANUP !==
      EXECUTION_CONFIRMATION
    ) {
      throw new Error(
        "Execution blocked: cleanup confirmation is missing or incorrect.",
      );
    }
  }

  console.log("Database host:", parsed.hostname);
  console.log("Database:", parsed.pathname.slice(1));
  console.log(
    execute
      ? "Mode: EXECUTE ? matching generated test data will be committed."
      : "Mode: PREVIEW ONLY ? all changes will be rolled back.",
  );

  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query(
      "SET LOCAL lock_timeout = '5s'; SET LOCAL statement_timeout = '2min';",
    );

    await createCleanupSets(client);
    await assertSafeBoundary(client);

    const protectedBefore = await client.query<{
      users: number;
      bookings: number;
    }>(`
      SELECT
        (
          SELECT COUNT(*)::int
          FROM users
          WHERE id NOT IN (SELECT id FROM cleanup_users)
        ) AS users,
        (
          SELECT COUNT(*)::int
          FROM bookings
          WHERE id NOT IN (SELECT id FROM cleanup_bookings)
        ) AS bookings
    `);

    const deleted: Array<{ table: string; rows: number }> = [];

    for (const step of deleteSteps) {
      console.log(`Previewing deletion from ${step.table}...`);
      const result = await client.query(step.sql);
      deleted.push({
        table: step.table,
        rows: result.rowCount ?? 0,
      });
    }

    const remaining = await client.query<{
      users: number;
      hosts: number;
      properties: number;
      bookings: number;
    }>(`
      SELECT
        (
          SELECT COUNT(*)::int
          FROM users
          WHERE LOWER(email) LIKE '${GENERATED_EMAIL_PATTERN}'
        ) AS users,
        (
          SELECT COUNT(*)::int
          FROM host_profiles
          WHERE id IN (SELECT id FROM cleanup_hosts)
        ) AS hosts,
        (
          SELECT COUNT(*)::int
          FROM properties
          WHERE id IN (SELECT id FROM cleanup_properties)
        ) AS properties,
        (
          SELECT COUNT(*)::int
          FROM bookings
          WHERE id IN (SELECT id FROM cleanup_bookings)
        ) AS bookings
    `);

    const protectedAfter = await client.query<{
      users: number;
      bookings: number;
    }>(`
      SELECT
        (
          SELECT COUNT(*)::int
          FROM users
          WHERE id NOT IN (SELECT id FROM cleanup_users)
        ) AS users,
        (
          SELECT COUNT(*)::int
          FROM bookings
          WHERE id NOT IN (SELECT id FROM cleanup_bookings)
        ) AS bookings
    `);

    console.log("Rows that would be deleted:");
    console.table(deleted);

    console.log("Generated records remaining inside transaction:");
    console.table(remaining.rows);

    if (
      Object.values(remaining.rows[0]).some(
        (count) => count !== 0,
      )
    ) {
      throw new Error(
        "Preview failed: generated records would remain.",
      );
    }

    if (
      protectedBefore.rows[0].users !==
        protectedAfter.rows[0].users ||
      protectedBefore.rows[0].bookings !==
        protectedAfter.rows[0].bookings
    ) {
      throw new Error(
        "Preview failed: protected user or booking totals changed.",
      );
    }

    if (execute) {
      await client.query("COMMIT");
      console.log(
        "Cleanup committed successfully.",
      );
    } else {
      await client.query("ROLLBACK");
      console.log(
        "Preview passed. Transaction rolled back; production was not changed.",
      );
    }
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
