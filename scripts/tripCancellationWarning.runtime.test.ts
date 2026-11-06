import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

function handler(response: any) {
  const source = fs.readFileSync("app/trips/[id]/page.tsx", "utf8");
  const tree = ts.createSourceFile("page.tsx", source,
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let initializer: ts.Expression | undefined;
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) &&
        node.name.getText(tree) === "confirmCancel") {
      initializer = node.initializer;
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.ok(initializer, "Cancellation handler missing");
  const compiled = ts.transpileModule(
    "globalThis.run = " + initializer.getText(tree),
    { compilerOptions: { target: ts.ScriptTarget.ES2020 } },
  ).outputText;
  const state = {
    notice: undefined as any,
    error: null as any,
    confirming: true,
    cancelling: false,
    reloads: 0,
    requests: 0,
  };
  const context: any = {
    bookingId: "fixture-booking",
    JSON,
    fetch: async (url: string, options: any) => {
      assert.equal(url, "/api/bookings/fixture-booking/cancel");
      assert.equal(options.method, "POST");
      state.requests++;
      return { json: async () => response };
    },
    setCancelNotice: (value: any) => { state.notice = value; },
    setCancelError: (value: any) => { state.error = value; },
    setShowConfirm: (value: boolean) => { state.confirming = value; },
    setCancelling: (value: boolean) => { state.cancelling = value; },
    loadBooking: () => { state.reloads++; },
  };
  vm.runInNewContext(compiled, context);
  return { state, run: () => context.run() };
}

test("successful cancellation retains its warning while refreshing booking data", async () => {
  const fixture = handler({ success: true, warning: " Refund needs follow-up. " });
  await fixture.run();
  assert.equal(fixture.state.notice.bookingId, "fixture-booking");
  assert.equal(fixture.state.notice.message, "Refund needs follow-up.");
  assert.equal(fixture.state.confirming, false);
  assert.equal(fixture.state.reloads, 1);
  assert.equal(fixture.state.requests, 1);
  assert.equal(fixture.state.error, null);
  assert.equal(fixture.state.cancelling, false);
});

test("successful cancellation ignores non-text warnings", async () => {
  const fixture = handler({ success: true, warning: { unexpected: true } });
  await fixture.run();
  assert.equal(fixture.state.notice, null);
  assert.equal(fixture.state.reloads, 1);
});

test("failed cancellation stays in the dialog without refreshing or showing success warnings", async () => {
  const fixture = handler({
    success: false, warning: "Must not display",
    error: { message: "Cancellation refused" },
  });
  await fixture.run();
  assert.equal(fixture.state.error, "Cancellation refused");
  assert.equal(fixture.state.notice, undefined);
  assert.equal(fixture.state.confirming, true);
  assert.equal(fixture.state.reloads, 0);
  assert.equal(fixture.state.cancelling, false);
});
