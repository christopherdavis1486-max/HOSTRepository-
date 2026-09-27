# HOST launch fee change

The launch configuration takes 15% of the VAT-exclusive accommodation price from the property owner. The guest service fee is zero. HOST pays its Stripe costs from the commission. Cleaning and the property VAT are payable to the property owner.

## Before activation

1. Confirm in contracts and invoices that HOST is acting as a disclosed agent, and confirm the VAT treatment for each property with the relevant tax adviser. Do not interpret a zero rate as a default for an unreviewed host.
2. Deploy the code and apply migration `033_property_vat_rates.sql` using the existing migration runner.
3. Set `accommodation_vat_rate` and `cleaning_vat_rate` on each published property after confirming its VAT-exclusive prices and tax treatment. Enter `0` only where no VAT is chargeable; for example, a confirmed 20% rate is `0.2000`. Do not copy a blanket rate across properties. Host onboarding does not yet collect these fields; configure them through the database until a reviewed host-facing tax form is built.
4. Run `npx tsx --env-file=.env.local scripts/activateLaunchFees.ts` against the intended database. It refuses to activate if any published property has an unreviewed rate or the current fee row differs from the expected `v1`. Inspect the printed result, then read the active `fee_configs` row.
5. Verify one new test-mode booking quote and its Stripe amount, host breakdown, refund, and payout. The old booking snapshots are not recalculated.

The new fee version uses the property rates for accommodation and cleaning separately; the old 5% global `tax_rate` is set to zero in that version. Bookings whose property VAT treatment is missing fail before charging. The new delayed-charge architecture has its own `tax_treatment` gate and remains disabled until separately configured.

The migration and code can be deployed before activation. Do not activate the database fee version until the code is deployed and the published properties have reviewed VAT rates. The host tax form, VAT invoice responsibilities, EU tax rules, and Stripe fee reconciliation are separate launch checks.
