import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { adminRefundSchema, validationErrorResponse } from "../lib/validation/schemas";

class AuthError extends Error {
  constructor(message: string, public status = 403) { super(message); }
}

function load(file: string, dependencies: Record<string, unknown>) {
  const exports: Record<string, any> = {};
  const compiled = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  }).outputText;
  vm.runInNewContext(compiled, {
    exports,
    console: { error() {} },
    require(name: string) {
      assert.ok(Object.prototype.hasOwnProperty.call(dependencies, name),
        "Unexpected dependency: " + name);
      return dependencies[name];
    },
  });
  return exports;
}

function setup(role: string, permitted = false) {
  const permissionQueries: unknown[][] = [];
  const routeQueries: string[] = [];
  const refunds: any[] = [];
  const audits: any[] = [];
  const session = { user: { id: "fixture-admin", adminRole: role } };

  const permissions = load("lib/auth/permissions.ts", {
    "./session": {
      AuthError,
      async requireRole(required: string) {
        assert.equal(required, "admin");
        if (role === "guest") throw new AuthError("Admin required", 403);
        return session;
      },
    },
    "../db": { db: { async query(_sql: string, values: unknown[]) {
      permissionQueries.push(values);
      return { rows: permitted ? [{}] : [] };
    } } },
  });

  const route = load("app/api/admin/refunds/route.ts", {
    "next/server": { NextResponse: { json: Response.json.bind(Response) } },
    "@/lib/auth/session": { AuthError },
    "@/lib/auth/permissions": permissions,
    "@/lib/validation/schemas": { adminRefundSchema, validationErrorResponse },
    "@/lib/payments/refund": { async initiateRefund(input: any) {
      refunds.push(input);
      return { stripeRefundId: "re_fixture", status: "pending" };
    } },
    "@/lib/db": { db: { async query(sql: string, values: unknown[]) {
      routeQueries.push(sql);
      if (sql.includes("FROM payments")) return { rows: [{
        payment_id: "fixture-payment", provider_payment_intent_id: "pi_fixture",
        currency: "GBP", paid_minor: 10000, status: "confirmed",
      }] };
      if (sql.includes("SUM(amount_minor)")) return { rows: [{ total: 0 }] };
      if (sql.includes("INSERT INTO audit_log")) {
        audits.push(values);
        return { rows: [] };
      }
      throw new Error("Unexpected route query");
    } } },
  });
  return { post: route.POST, permissionQueries, routeQueries, refunds, audits };
}

const body = {
  bookingId: "bb9b059d-9845-41ff-a117-c3f90e3e9e76",
  amountMinor: 2500, reason: "admin_goodwill",
};

for (const role of ["guest", "support_without_refund_permission"]) {
  test("admin refund rejects " + role + " before reading the body or touching funds", async () => {
    const fixture = setup(role);
    let bodyReads = 0;
    const response = await fixture.post({
      async json() { bodyReads++; return body; },
    });
    assert.equal(response.status, 403);
    assert.equal(bodyReads, 0);
    assert.equal(fixture.routeQueries.length, 0);
    assert.equal(fixture.refunds.length, 0);
    assert.equal(fixture.audits.length, 0);
    if (role !== "guest") {
      assert.equal(JSON.stringify(fixture.permissionQueries),
        JSON.stringify([[role, "refunds", "write"]]));
    }
  });
}

for (const role of ["finance", "super_admin"]) {
  test("admin refund permits authorized " + role + " and derives its actor server-side", async () => {
    const fixture = setup(role, role === "finance");
    const response = await fixture.post({
      async json() {
        return { ...body, initiatedBy: "guest", adminRole: "forged", paymentId: "forged" };
      },
    });
    assert.equal(response.status, 200);
    assert.equal(fixture.refunds.length, 1);
    assert.equal(fixture.refunds[0].initiatedBy, "admin");
    assert.equal(fixture.refunds[0].paymentId, "fixture-payment");
    assert.equal(fixture.refunds[0].providerPaymentIntentId, "pi_fixture");
    assert.equal(fixture.audits[0][0], "fixture-admin");
    assert.equal(JSON.parse(fixture.audits[0][2]).adminRole, role);
    assert.equal(fixture.permissionQueries.length, role === "super_admin" ? 0 : 1);
  });
}
