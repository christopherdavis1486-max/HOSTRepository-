CREATE TABLE newsletter_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  locale VARCHAR(5) NOT NULL DEFAULT 'en',
  status TEXT NOT NULL DEFAULT 'subscribed'
    CHECK (status IN ('subscribed', 'unsubscribed')),
  consent_source TEXT NOT NULL,
  consented_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  unsubscribed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX newsletter_subscriptions_email_unique
  ON newsletter_subscriptions (LOWER(email));

CREATE INDEX newsletter_subscriptions_status_idx
  ON newsletter_subscriptions (status, consented_at DESC);
