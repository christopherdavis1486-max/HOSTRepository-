# HOST mobile web app

The manifest and icons allow a supported mobile browser to offer HOST as a home screen web app. This is a browser-based app; it requires a network connection for booking, messages, account data and payments. No service worker caches authenticated pages or payment responses.

After deployment, check `/manifest.webmanifest`, `/icon-192.png` and `/icon-512.png`. On iPhone, use Safari's Share menu to add HOST to the Home Screen. On Android, check the browser's install option. Open the installed app, sign in, view trips, use the host property editor, and test checkout only with Stripe test mode after the property VAT review.

The iPhone 17 browser smoke test covered sign-in, My trips and the host property editor on 28 September 2026. Android and installed app behaviour are pending device checks. Native App Store and Google Play submissions are separate work.
