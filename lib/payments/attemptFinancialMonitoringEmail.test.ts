import {test} from "node:test";
import assert from "node:assert/strict";
import {attemptFinancialMonitoringEmail as attempt}
  from "./attemptFinancialMonitoringEmail";

const message = {
  to: "operator@example.test",
  subject: "HOST monitoring warning",
  body: "A named monitoring condition requires review."
};

test("provider message id records acceptance without claiming inbox delivery", async () => {
  let calls = 0;
  const before = structuredClone(message);
  const result = await attempt(message, async input => {
    calls++;
    assert.deepEqual(input, message);
    input.body = "sender mutation";
    return {data: {id: "fixture-message-1"}, error: null};
  });
  assert.deepEqual(result, {
    status: "accepted", providerMessageId: "fixture-message-1"
  });
  assert.equal(calls, 1);
  assert.deepEqual(message, before);
});

test("explicit provider rejection is recorded without exposing its error", async () => {
  const result = await attempt(message, async () => ({
    data: null, error: {message: "private-provider-detail"}
  }));
  assert.deepEqual(result, {status: "rejected"});
  assert.ok(!JSON.stringify(result).includes("private-provider-detail"));
});

test("throws, missing ids and contradictory responses remain uncertain without retry", async () => {
  const responses = [
    undefined, {}, {data: {id: ""}, error: null},
    {data: {id: "fixture-id"}, error: {message: "conflict"}}
  ];
  for (const response of responses) {
    let calls = 0;
    assert.deepEqual(await attempt(message, async () => {
      calls++;
      return response;
    }), {status: "uncertain"});
    assert.equal(calls, 1);
  }
  let calls = 0;
  assert.deepEqual(await attempt(message, async () => {
    calls++;
    throw new Error("private-network-detail");
  }), {status: "uncertain"});
  assert.equal(calls, 1);
});

test("invalid message fails before invoking sender", async () => {
  let calls = 0;
  for (const invalid of [
    {...message, to: "invalid"},
    {...message, subject: "Injected\r\nHeader"},
    {...message, body: ""}
  ]) {
    await assert.rejects(attempt(invalid, async () => {calls++;}));
  }
  assert.equal(calls, 0);
});
