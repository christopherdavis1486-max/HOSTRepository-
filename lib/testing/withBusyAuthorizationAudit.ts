import { mock } from "node:test";
import assert from "node:assert/strict";
import { db } from "../db";

/** Test-only scheduling probe; every competing mutation is rolled back. */
export async function withBusyAuthorizationAudit<T>(
  auditId: string, mutation: "update" | "delete", run: () => Promise<T>
): Promise<{ value?: T; error?: any }> {
  const competing = await db.connect();
  let pending: Promise<any> | undefined;
  let mutationResult: any;
  let injected = false;
  let probeError: unknown;
  let lockCode: string | undefined;
  const originalConnect = db.connect.bind(db);
  await competing.query("BEGIN");
  await competing.query("SET LOCAL statement_timeout = '5s'");
  const competingPid = (await competing.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
  const patched = mock.method(db, "connect", function (...args: any[]) {
    if (args.length) return (originalConnect as any)(...args);
    return originalConnect().then(client => {
      const query = client.query.bind(client);
      const release = client.release.bind(client);
      client.query = (async (...queryArgs: any[]) => {
        const sql = typeof queryArgs[0] === "string" ? queryArgs[0] : queryArgs[0]?.text;
        const target = !injected && /FROM audit_log/.test(sql ?? "") && /FOR SHARE/.test(sql ?? "");
        if (target) {
          injected = true;
          try {
            const workerPid = (await query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
            pending = competing.query(
              mutation === "update"
                ? "UPDATE audit_log SET actor_user_id = NULL WHERE id = $1"
                : "DELETE FROM audit_log WHERE id = $1", [auditId]
            ).then(value => ({ value }), error => ({ error }));
            let blocked = false;
            const deadline = Date.now() + 2000;
            while (Date.now() < deadline) {
              const result = await db.query(
                "SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked",
                [workerPid, competingPid]
              );
              if (result.rows[0].blocked) { blocked = true; break; }
              await new Promise(resolve => setTimeout(resolve, 10));
            }
            assert.equal(blocked, true, "Audit mutation must wait for worker booking");
          } catch (error) { probeError = error; throw error; }
        }
        try { return await (query as any)(...queryArgs); }
        catch (error: any) {
          if (target) lockCode = error.code;
          throw error;
        }
      }) as any;
      client.release = ((...releaseArgs: any[]) => {
        client.query = query as any;
        client.release = release;
        return (release as any)(...releaseArgs);
      }) as any;
      return client;
    });
  } as any);
  let outcome: { value?: T; error?: any };
  try {
    try { outcome = { value: await run() }; }
    catch (error) { outcome = { error }; }
  } finally {
    patched.mock.restore();
    try { if (pending) mutationResult = await pending; }
    finally {
      try { await competing.query("ROLLBACK"); }
      finally { competing.release(); }
    }
  }
  assert.ifError(probeError);
  assert.equal(injected, true);
  assert.equal(lockCode, "55P03", "Audit evidence must refuse contention immediately");
  if (mutationResult?.error) {
    assert.equal(mutationResult.error.code, "23503", "Only a foreign-key refusal is expected");
  } else {
    assert.equal(mutationResult?.value?.rowCount, 1);
  }
  return outcome;
}
