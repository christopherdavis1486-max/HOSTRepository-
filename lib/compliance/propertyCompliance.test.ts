import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ownerComplianceSchema, adminComplianceReviewSchema } from "../validation/schemas";
import { COMPLIANCE_CATEGORIES } from "./propertyCompliance";

const completeItems = COMPLIANCE_CATEGORIES.map((category) => ({
  category,
  applicability: "required" as const,
  ownerDeclaredCompliant: true,
  evidenceUrl: "https://documents.example/evidence.pdf",
  evidenceReference: "Certificate reference",
  validUntil: "2027-12-31",
  ownerNote: "",
}));

test("owner compliance requires each of the seven categories exactly once", () => {
  assert.equal(ownerComplianceSchema.safeParse({ submit: true, items: completeItems }).success, true);
  const duplicate = completeItems.map((item) => ({ ...item }));
  duplicate[6].category = duplicate[0].category;
  assert.equal(ownerComplianceSchema.safeParse({ submit: true, items: duplicate }).success, false);
});

test("evidence links must be HTTPS", () => {
  const unsafe = completeItems.map((item) => ({ ...item }));
  unsafe[0].evidenceUrl = "http://documents.example/evidence.pdf";
  assert.equal(ownerComplianceSchema.safeParse({ submit: true, items: unsafe }).success, false);
});

test("core checks cannot be marked not applicable", () => {
  const invalid = completeItems.map((item, index) => index === 0 ? { ...item, applicability: "not_applicable" as const, ownerDeclaredCompliant: false } : { ...item });
  assert.equal(ownerComplianceSchema.safeParse({ submit: true, items: invalid }).success, false);
  const conditional = completeItems.map((item, index) => index === 2 ? { ...item, applicability: "not_applicable" as const, ownerDeclaredCompliant: false } : { ...item });
  assert.equal(ownerComplianceSchema.safeParse({ submit: true, items: conditional }).success, true);
});

test("a conditional not-applicable item ignores a stale hidden evidence value", () => {
  const conditional = completeItems.map((item, index) => index === 2 ? { ...item, applicability: "not_applicable" as const, ownerDeclaredCompliant: false, evidenceUrl: "stale hidden value" } : { ...item });
  assert.equal(ownerComplianceSchema.safeParse({ submit: true, items: conditional }).success, true);
});

test("an admin decision requires a meaningful audit note", () => {
  assert.equal(adminComplianceReviewSchema.safeParse({ decision: "approved", note: "ok" }).success, false);
  assert.equal(adminComplianceReviewSchema.safeParse({ decision: "approved", note: "Evidence checked and current." }).success, true);
});

test("the public property response never exposes evidence URLs or internal compliance notes", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "app/api/properties/[id]/route.ts"), "utf8");
  const publicObject = source.slice(source.indexOf("return NextResponse.json({"));
  assert.equal(publicObject.includes("evidence_url"), false);
  assert.equal(publicObject.includes("reviewer_note"), false);
  assert.equal(publicObject.includes("owner_note"), false);
});

test("the compliance reviewer is prohibited from approving their own property", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "lib/compliance/propertyCompliance.ts"), "utf8");
  assert.ok(source.includes("owner_user_id === reviewerUserId"));
  assert.ok(source.includes("cannot review their own compliance submission"));
});
