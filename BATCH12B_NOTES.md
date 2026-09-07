# HOST Batch 12B — German and French guest journey

## Included

- German and French interface copy for search results and stay discovery.
- Localised stay booking controls, availability calendar labels and dates.
- German and French My Trips list and core trip-detail controls.
- Localised checkout, saved-card and payment confirmation/recovery states.
- Stripe-hosted card fields remain supplied securely by Stripe.
- Spanish, Italian and Dutch deliberately retain English guest-journey copy until Batch 12C.

## Content boundaries

- Property names, descriptions and house rules remain in the language supplied by the host; HOST does not silently machine-translate owner-authored claims.
- Cancellation-policy wording and other binding legal terms remain authoritative English. German and French interfaces explicitly identify the cancellation policy as authoritative English.
- Backend/API error text can remain English when it is a specific server response; safe interface fallbacks are translated.

## Database

No new migration is required. Batch 12B reuses `users.preferred_locale` and the `host_locale` cookie from Batch 12A.
