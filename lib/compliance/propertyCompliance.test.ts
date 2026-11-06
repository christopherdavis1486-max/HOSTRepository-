import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  ownerComplianceSchema,
  adminComplianceReviewSchema,
} from "../validation/schemas";
import {
  COMPLIANCE_CATEGORIES,
} from "./propertyCompliance";

const completeItems = COMPLIANCE_CATEGORIES.map(
  (category) => ({
    category,
    applicability: "required" as const,
    ownerDeclaredCompliant: true,
    evidenceUrl:
      "https://documents.example/evidence.pdf",
    evidenceReference: "Certificate reference",
    validUntil: "2027-12-31",
    ownerNote: "",
  })
);

test(
  "owner compliance requires each of the seven categories exactly once",
  () => {
    assert.equal(
      ownerComplianceSchema.safeParse({
        submit: true,
        items: completeItems,
      }).success,
      true
    );

    const duplicate = completeItems.map(
      (item) => ({ ...item })
    );

    duplicate[6].category =
      duplicate[0].category;

    assert.equal(
      ownerComplianceSchema.safeParse({
        submit: true,
        items: duplicate,
      }).success,
      false
    );
  }
);

test("evidence links must be HTTPS", () => {
  const unsafe = completeItems.map(
    (item) => ({ ...item })
  );

  unsafe[0].evidenceUrl =
    "http://documents.example/evidence.pdf";

  assert.equal(
    ownerComplianceSchema.safeParse({
      submit: true,
      items: unsafe,
    }).success,
    false
  );
});

test(
  "core checks cannot be marked not applicable",
  () => {
    const invalid = completeItems.map(
      (item, index) =>
        index === 0
          ? {
              ...item,
              applicability:
                "not_applicable" as const,
              ownerDeclaredCompliant: false,
            }
          : { ...item }
    );

    assert.equal(
      ownerComplianceSchema.safeParse({
        submit: true,
        items: invalid,
      }).success,
      false
    );

    const conditional = completeItems.map(
      (item, index) =>
        index === 2
          ? {
              ...item,
              applicability:
                "not_applicable" as const,
              ownerDeclaredCompliant: false,
            }
          : { ...item }
    );

    assert.equal(
      ownerComplianceSchema.safeParse({
        submit: true,
        items: conditional,
      }).success,
      true
    );
  }
);

test(
  "a conditional not-applicable item ignores a stale hidden evidence value",
  () => {
    const conditional = completeItems.map(
      (item, index) =>
        index === 2
          ? {
              ...item,
              applicability:
                "not_applicable" as const,
              ownerDeclaredCompliant: false,
              evidenceUrl: "stale hidden value",
            }
          : { ...item }
    );

    assert.equal(
      ownerComplianceSchema.safeParse({
        submit: true,
        items: conditional,
      }).success,
      true
    );
  }
);

test(
  "drafts allow incomplete evidence links until submission",
  () => {
    const incomplete = completeItems.map(
      (item) => ({
        ...item,
        ownerDeclaredCompliant: false,
        evidenceUrl: "",
      })
    );

    assert.equal(
      ownerComplianceSchema.safeParse({
        submit: false,
        items: incomplete,
      }).success,
      true
    );

    assert.equal(
      ownerComplianceSchema.safeParse({
        submit: true,
        items: incomplete,
      }).success,
      false
    );
  }
);

test(
  "an admin decision requires a meaningful audit note",
  () => {
    assert.equal(
      adminComplianceReviewSchema.safeParse({
        decision: "approved",
        note: "ok",
      }).success,
      false
    );

    assert.equal(
      adminComplianceReviewSchema.safeParse({
        decision: "approved",
        note: "Evidence checked and current.",
      }).success,
      true
    );
  }
);

test(
  "the public property response never exposes evidence URLs or internal compliance notes",
  () => {
    const source = fs.readFileSync(
      path.join(
        process.cwd(),
        "app/api/properties/[id]/route.ts"
      ),
      "utf8"
    );

    const publicObject = source.slice(
      source.indexOf(
        "return NextResponse.json({"
      )
    );

    assert.equal(
      publicObject.includes("evidence_url"),
      false
    );
    assert.equal(
      publicObject.includes("reviewer_note"),
      false
    );
    assert.equal(
      publicObject.includes("owner_note"),
      false
    );
  }
);

test(
  "the compliance reviewer is prohibited from approving their own property",
  () => {
    const source = fs.readFileSync(
      path.join(
        process.cwd(),
        "lib/compliance/propertyCompliance.ts"
      ),
      "utf8"
    );

    assert.ok(
      source.includes(
        "owner_user_id === reviewerUserId"
      )
    );
    assert.ok(
      source.includes(
        "cannot review their own compliance submission"
      )
    );
  }
);

test(
  "the admin review screen displays owner references and notes",
  () => {
    const source = fs.readFileSync(
      path.join(
        process.cwd(),
        "app/admin/property-compliance/page.tsx"
      ),
      "utf8"
    );

    assert.ok(
      source.includes("item.evidence_reference")
    );
    assert.ok(source.includes("item.owner_note"));
    assert.ok(
      source.includes(
        '"Reference or explanation"'
      )
    );
    assert.ok(source.includes('"Owner note"'));
  }
);
test("draft evidence URL regression: malformed populated links fail for drafts and submissions", () => {
  for (const submit of [false, true]) {
    for (const evidenceUrl of [
      ": https://example.test/host-local-test/electrical-safety",
      "http://example.test/evidence",
      "https://",
      "https:example.test/evidence",
      "HTTPS://example.test/evidence",
      "https://example.test/bad link",
      "not a URL"
    ]) {
      const items = completeItems.map(item => ({ ...item }));
      items[3].evidenceUrl = evidenceUrl;
      const result = ownerComplianceSchema.safeParse({ submit, items });
      assert.equal(result.success, false, JSON.stringify({ submit, evidenceUrl }));
      if (!result.success) {
        const issue = result.error.issues.find(issue =>
          issue.path.join(".") === "items.3.evidenceUrl");
        assert.ok(issue);
        assert.match(issue.message, /electrical safety.*https:\/\//);
      }
    }
  }
});

test("draft evidence URL regression: blank drafts remain allowed and valid URLs are trimmed", () => {
  for (const evidenceUrl of ["", "   ", null, undefined]) {
    const items = completeItems.map(item => ({ ...item, evidenceUrl }));
    assert.equal(ownerComplianceSchema.safeParse({ submit: false, items }).success, true);
    assert.equal(ownerComplianceSchema.safeParse({ submit: true, items }).success, false);
  }
  for (const submit of [false, true]) {
    const items = completeItems.map(item => ({
      ...item, evidenceUrl: "  https://example.test/evidence.pdf  "
    }));
    const result = ownerComplianceSchema.safeParse({ submit, items });
    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.data.items[0].evidenceUrl, "https://example.test/evidence.pdf");
    }
  }
});

test("draft evidence URL regression: not-applicable hidden links are ignored in both modes", () => {
  for (const submit of [false, true]) {
    const items = completeItems.map(item => ({
      ...item,
      ...(item.category === "gas_safety" ? {
        applicability: "not_applicable" as const,
        ownerDeclaredCompliant: false,
        evidenceUrl: ": https://stale.example.test/evidence",
        evidenceReference: "No gas supply in this fictional test"
      } : {})
    }));
    assert.equal(ownerComplianceSchema.safeParse({ submit, items }).success, true);
  }
});

test("draft evidence URL regression: route returns 400 before saving malformed links", async () => {
  const { createRequire } = await import("node:module");
  const { default: vm } = await import("node:vm");
  const { validationErrorResponse } = await import("../validation/schemas");
  const ts = createRequire(import.meta.url)("typescript");
  const calls: any[][] = [];
  class AuthError extends Error {
    constructor(message: string, public status: number) { super(message); }
  }
  const adapters: Record<string, any> = {
    "next/server": {
      NextResponse: { json: (body: any, options: any = {}) =>
        ({ body, status: options.status ?? 200 }) }
    },
    "@/lib/auth/session": {
      AuthError,
      requireSession: async () => ({ user: { id: "fixture-user" } })
    },
    "@/lib/auth/hostAccess": {
      resolveHostPropertyAccess: async () => {}
    },
    "@/lib/compliance/propertyCompliance": {
      getPropertyCompliance: async () => { throw new Error("Unexpected read"); },
      saveOwnerCompliance: async (...args: any[]) => {
        calls.push(args);
        return { status: "in_progress" };
      }
    },
    "@/lib/validation/schemas": { ownerComplianceSchema, validationErrorResponse }
  };
  const module = { exports: {} as any };
  const compiled = ts.transpileModule(fs.readFileSync(
    "app/api/host/properties/[id]/compliance/route.ts", "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020
      }
    }).outputText;
  vm.runInNewContext(compiled, {
    module, exports: module.exports, Error,
    console: { error() { throw new Error("Unexpected server error"); } },
    require(name: string) {
      assert.ok(Object.prototype.hasOwnProperty.call(adapters, name), name);
      return adapters[name];
    }
  });
  for (const submit of [false, true]) {
    const items = completeItems.map(item => ({ ...item }));
    items[3].evidenceUrl = ": https://example.test/host-local-test/electrical-safety";
    const response = await module.exports.PUT(
      { json: async () => ({ submit, items }) },
      { params: Promise.resolve({ id: "fixture-property" }) }
    );
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "INVALID_INPUT");
    assert.deepEqual(JSON.parse(JSON.stringify(response.body.error.issues[0].path)),
      ["items", 3, "evidenceUrl"]);
    assert.match(response.body.error.issues[0].message, /electrical safety/);
    assert.deepEqual(Object.keys(response.body.error.issues[0]).sort(),
      ["message", "path"]);
    assert.match(response.body.error.message, /electrical safety/);
    assert.equal(calls.length, 0);
  }
  const response = await module.exports.PUT(
    { json: async () => ({
      submit: false,
      items: completeItems.map(item => ({
        ...item, evidenceUrl: "  https://example.test/evidence.pdf  "
      }))
    }) },
    { params: Promise.resolve({ id: "fixture-property" }) }
  );
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "fixture-property");
  assert.equal(calls[0][1], "fixture-user");
  assert.equal(calls[0][2][0].evidenceUrl, "https://example.test/evidence.pdf");
  assert.equal(calls[0][3], false);
});
