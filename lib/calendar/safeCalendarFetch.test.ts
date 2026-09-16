import test from "node:test";
import assert from "node:assert/strict";
import {
  CalendarFetchError,
  assertSafeCalendarUrl,
  isBlockedNetworkAddress,
} from "./safeCalendarFetch";

test("accepts a public HTTPS calendar URL", async () => {
  const url = await assertSafeCalendarUrl(
    "https://calendar.example.com/property.ics",
    async () => [
      {
        address: "93.184.216.34",
        family: 4,
      },
    ],
  );

  assert.equal(
    url.toString(),
    "https://calendar.example.com/property.ics",
  );
});

test("rejects non-HTTPS calendar URLs", async () => {
  await assert.rejects(
    () =>
      assertSafeCalendarUrl(
        "http://calendar.example.com/property.ics",
      ),
    CalendarFetchError,
  );

  await assert.rejects(
    () =>
      assertSafeCalendarUrl(
        "file:///etc/passwd",
      ),
    CalendarFetchError,
  );
});

test("rejects embedded credentials and nonstandard ports", async () => {
  await assert.rejects(
    () =>
      assertSafeCalendarUrl(
        "https://user:password@example.com/feed.ics",
      ),
    CalendarFetchError,
  );

  await assert.rejects(
    () =>
      assertSafeCalendarUrl(
        "https://example.com:8443/feed.ics",
      ),
    CalendarFetchError,
  );
});

test("rejects localhost and internal hostnames", async () => {
  for (const hostname of [
    "localhost",
    "calendar.localhost",
    "service.local",
    "metadata.internal",
    "router.lan",
  ]) {
    await assert.rejects(
      () =>
        assertSafeCalendarUrl(
          `https://${hostname}/feed.ics`,
        ),
      CalendarFetchError,
    );
  }
});

test("rejects hostnames resolving to private addresses", async () => {
  await assert.rejects(
    () =>
      assertSafeCalendarUrl(
        "https://calendar.example/feed.ics",
        async () => [
          {
            address: "10.0.0.8",
            family: 4,
          },
        ],
      ),
    CalendarFetchError,
  );
});

test("rejects mixed DNS answers if any address is private", async () => {
  await assert.rejects(
    () =>
      assertSafeCalendarUrl(
        "https://calendar.example/feed.ics",
        async () => [
          {
            address: "93.184.216.34",
            family: 4,
          },
          {
            address: "127.0.0.1",
            family: 4,
          },
        ],
      ),
    CalendarFetchError,
  );
});

test("rejects cloud metadata and reserved IPv4 ranges", () => {
  for (const address of [
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.1.1",
    "198.18.0.1",
    "224.0.0.1",
  ]) {
    assert.equal(
      isBlockedNetworkAddress(address),
      true,
      address,
    );
  }
});

test("rejects private and local IPv6 ranges", () => {
  for (const address of [
    "::",
    "::1",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "ff02::1",
    "2001:db8::1",
    "::ffff:127.0.0.1",
  ]) {
    assert.equal(
      isBlockedNetworkAddress(address),
      true,
      address,
    );
  }
});

test("allows public IPv4 and IPv6 addresses", () => {
  assert.equal(
    isBlockedNetworkAddress("8.8.8.8"),
    false,
  );

  assert.equal(
    isBlockedNetworkAddress(
      "2606:4700:4700::1111",
    ),
    false,
  );
});

test("rejects unresolvable calendar hosts", async () => {
  await assert.rejects(
    () =>
      assertSafeCalendarUrl(
        "https://missing.example/feed.ics",
        async () => [],
      ),
    CalendarFetchError,
  );
});