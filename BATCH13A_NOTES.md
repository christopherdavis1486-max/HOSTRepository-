# HOST Batch 13A — Staging readiness

## Outcome

The application is ready to begin controlled staging configuration, but it is
not yet ready to accept public traffic. Batch 13A adds a fail-closed environment
preflight and a staging-specific environment template.

## Safety position

- Stripe keys must remain test-mode (`sk_test_` and `pk_test_`).
- Delayed charging, automated off-session charging and host-transfer execution
  remain disabled while Stripe's Funds Segregation review is pending.
- Tax treatment remains `unconfigured` until written legal/accounting approval.
- Staging requires Upstash because Vercel runs preview deployments with
  production security behaviour; protected mutations fail closed without it.
- Cron requires a long `CRON_SECRET` and refuses unauthenticated execution.
- Staging uses a separate database and must never point to localhost.

## Operator workflow

1. Copy `.env.staging.example` to `.env.staging.local`.
2. Fill it locally without sharing or committing secrets.
3. Run `npm run staging:preflight`.
4. Do not deploy until the preflight reports zero errors.
5. Add the same values to the staging deployment environment only.
6. Run migrations and idempotent seed against the staging database.
7. Register separate classic and Accounts v2 Stripe test webhook destinations.

The preflight prints configuration names and safe results only; it never prints
secret values.
