# HOST Batch 12A — multilingual foundations

## Included

- Six supported interface languages: English, German, French, Spanish, Italian and Dutch.
- One shared language selector used by the public/customer and host navigation.
- Guest preference stored for one year in the `host_locale` cookie.
- Signed-in preference also stored on the user account in `users.preferred_locale`.
- Browser-language normalization with a safe English fallback.
- Initial translated home page, account navigation and host navigation.
- A typed translation dictionary so later batches can add screens without scattered conditional text.

## Legal-language safeguard

Terms of Service, Privacy Policy, host agreements and cancellation terms are authoritative English content. `localeForContent("legal", ...)` always returns English, regardless of the interface preference. Translated interface dictionaries must not contain legal-document text.

## Migration

Run `npm.cmd run migrate` to apply `025_language_preferences.sql` before starting the app.

## Deliberate scope

Batch 12A installs the framework and proves it on the highest-visibility navigation and home page. Later Batch 12 work can translate search, property, checkout, account, host tools, notifications and transactional email progressively without changing the preference model.
