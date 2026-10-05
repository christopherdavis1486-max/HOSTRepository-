import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

// Fresh processes exercise the actual pg parser registration in each timezone.
// No database connection or query is made.
for (const timezone of ["Europe/London", "UTC", "America/Los_Angeles", "Pacific/Auckland"]) {
  test(`calendar dates survive JSON and repeated saves in ${timezone}`, () => {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import assert from 'node:assert/strict';
      import pg from 'pg';
      await import('./lib/db/index.ts');
      const { formatDate } = await import('./lib/presentation/formatters.ts');
      const parse = pg.types.getTypeParser(pg.types.builtins.DATE, 'text');
      for (const day of ['2026-10-20', '2026-10-22', '2027-09-30', '2026-03-29', '2026-10-25', '2028-02-29']) {
        assert.equal(parse(day), day);
        const body = JSON.parse(JSON.stringify({checkIn: parse(day), valid_until: parse(day)}));
        assert.equal(body.checkIn, day);
        let form = body.valid_until;
        for (let save = 0; save < 5; save++) form = JSON.parse(JSON.stringify({valid_until: parse(form)})).valid_until.slice(0, 10);
        assert.equal(form, day);
      }
      assert.equal(formatDate(parse('2026-10-20')), '20 Oct 2026');
      const stamp = pg.types.getTypeParser(pg.types.builtins.TIMESTAMPTZ, 'text')('2026-10-20 12:34:56+00');
      assert.ok(stamp instanceof Date);
      assert.equal(stamp.toISOString(), '2026-10-20T12:34:56.000Z');
    `], {cwd: process.cwd(), encoding: "utf8", env: {...process.env, TZ: timezone, DATABASE_URL: "postgres://localhost/host_test", TEST_DATABASE_HOST: "localhost"}});
    assert.equal(result.status, 0, result.stderr || result.stdout);
  });
}
