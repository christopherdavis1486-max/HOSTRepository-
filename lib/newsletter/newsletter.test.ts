import { after, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { NextRequest } from "next/server";
import { db } from "../db";
import { POST } from "../../app/api/newsletter/route";

const testEmails: string[] = [];

function newsletterRequest(body: unknown) {
  return new NextRequest(
    "http://localhost/api/newsletter",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost",
      },
      body: JSON.stringify(body),
    },
  );
}

function uniqueEmail(label: string) {
  const email =
    `newsletter-${label}-${crypto.randomUUID()}@test.host`;
  testEmails.push(email);
  return email;
}

after(async () => {
  if (testEmails.length > 0) {
    await db.query(
      `DELETE FROM newsletter_subscriptions
       WHERE email = ANY($1::text[])`,
      [testEmails],
    );
  }

  await db.end();
});

test("newsletter subscription records explicit consent", async () => {
  const originalEmail = uniqueEmail("consent");
  const submittedEmail = originalEmail.toUpperCase();

  const response = await POST(
    newsletterRequest({
      email: submittedEmail,
      consent: true,
      locale: "en",
      website: "",
    }),
  );

  assert.equal(response.status, 202);

  const result = await db.query(
    `SELECT
       email,
       locale,
       status,
       consent_source,
       consented_at,
       unsubscribed_at
     FROM newsletter_subscriptions
     WHERE email = $1`,
    [originalEmail],
  );

  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].email, originalEmail);
  assert.equal(result.rows[0].locale, "en");
  assert.equal(result.rows[0].status, "subscribed");
  assert.equal(
    result.rows[0].consent_source,
    "homepage_footer",
  );
  assert.ok(result.rows[0].consented_at);
  assert.equal(result.rows[0].unsubscribed_at, null);
});

test("repeat subscription remains duplicate-safe", async () => {
  const email = uniqueEmail("duplicate");

  const first = await POST(
    newsletterRequest({
      email,
      consent: true,
      locale: "en",
      website: "",
    }),
  );

  const second = await POST(
    newsletterRequest({
      email: email.toUpperCase(),
      consent: true,
      locale: "fr",
      website: "",
    }),
  );

  assert.equal(first.status, 202);
  assert.equal(second.status, 202);

  const result = await db.query(
    `SELECT COUNT(*)::int AS count, MAX(locale) AS locale
     FROM newsletter_subscriptions
     WHERE LOWER(email) = LOWER($1)`,
    [email],
  );

  assert.equal(result.rows[0].count, 1);
  assert.equal(result.rows[0].locale, "fr");
});

test("newsletter subscription requires explicit consent", async () => {
  const email = uniqueEmail("no-consent");

  const response = await POST(
    newsletterRequest({
      email,
      consent: false,
      locale: "en",
      website: "",
    }),
  );

  assert.equal(response.status, 400);

  const result = await db.query(
    `SELECT COUNT(*)::int AS count
     FROM newsletter_subscriptions
     WHERE email = $1`,
    [email],
  );

  assert.equal(result.rows[0].count, 0);
});

test("newsletter honeypot accepts silently without storing data", async () => {
  const email = uniqueEmail("honeypot");

  const response = await POST(
    newsletterRequest({
      email,
      consent: true,
      locale: "en",
      website: "https://spam.invalid",
    }),
  );

  assert.equal(response.status, 202);

  const result = await db.query(
    `SELECT COUNT(*)::int AS count
     FROM newsletter_subscriptions
     WHERE email = $1`,
    [email],
  );

  assert.equal(result.rows[0].count, 0);
});
