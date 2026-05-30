# Bradley — Google Play licensing ($5/year)

Bradley targets a **$5 USD annual subscription** on Google Play. This document covers product setup, client libraries, server receipt validation, and testing. Full Play Billing integration is **not implemented yet**; the database exposes `users.subscription_status` (default `trial`) as a placeholder.

## Product model

| Item | Recommendation |
|------|----------------|
| Type | **Auto-renewing subscription** (annual) |
| Price | $4.99 USD (Play allows regional pricing) |
| Product ID | `bradley_annual` or `com.bradley.app.annual` |
| Base plan ID (Play Console v5+) | `annual-standard` |
| Grace period | Enable in Play Console (e.g. 3 days) for failed renewals |

Use one subscription product with a single annual base plan. Avoid consumables or one-time IAP for recurring access.

## Client: react-native-iap vs RevenueCat

Both work with Expo/React Native; choice depends on who owns subscription logic.

### react-native-iap

- **Pros:** Direct Google Play Billing API; no third-party fee; full control; works with custom Node backend for receipt validation.
- **Cons:** You implement purchase flow, restore, subscription status sync, and server validation. Requires **development build** (not Expo Go) and Play Console + license testers for real billing.
- **Expo:** Install `react-native-iap`, add config plugin or prebuild, ship via EAS Build. Listen to `purchaseUpdatedListener`, finish transactions, send `purchaseToken` to Bradley API.

### RevenueCat

- **Pros:** Dashboard for products, entitlements, analytics; wraps StoreKit/Play Billing; webhooks to your server; faster MVP for multi-store later.
- **Cons:** Vendor dependency; pricing at scale; still need development build for native stores.
- **Expo:** `react-native-purchases` + RevenueCat project; map entitlement `pro` → `subscription_status = active` on server via webhook.

### Recommendation for Bradley

- **MVP / single Android app, existing Node API:** Start with **react-native-iap** + a small `POST /billing/verify` on Bradley API (see below). Keeps stack simple and matches self-hosted VM.
- **If iOS + Android + experiments on pricing:** Consider **RevenueCat** early to avoid duplicating receipt logic.

## Server receipt validation (sketch)

Google Play subscriptions use the **Google Play Developer API** (not a simple shared secret like Apple’s old receipt blob).

```text
Mobile app                    Bradley API                    Google
    |                              |                            |
    |-- purchase (productId,       |                            |
    |    purchaseToken, package) ->|                            |
    |                              |-- subscriptionsv2.get ---->|
    |                              |<-- state, expiryTime -------|
    |                              |                            |
    |                              | UPDATE users SET             |
    |                              | subscription_status='active' |
    |<-- { ok, status } -----------|                            |
```

### Steps

1. **Service account** in Google Cloud (project linked to Play Console): role *View financial data* / Android Publisher API.
2. Enable **Google Play Android Developer API**.
3. Store JSON key path or secret in `app_settings` (e.g. `google_play_service_account_json`) — admin-only, never return raw to clients.
4. Endpoint sketch:

```js
// POST /billing/verify  (auth required)
// body: { purchaseToken, productId, packageName: 'com.bradley.app' }
// 1. Call androidpublisher.purchases.subscriptionsv2.get
// 2. If subscriptionState is SUBSCRIPTION_STATE_ACTIVE (or in grace), set subscription_status = 'active'
// 3. Else if expired/canceled, set 'expired' or 'trial'
// 4. Optionally persist purchase_token + expiry in a future `subscriptions` table
```

### `subscriptions` table (future)

For audit and renewals, prefer a dedicated table over only `users.subscription_status`:

```sql
CREATE TABLE subscriptions (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  product_id TEXT NOT NULL,
  purchase_token TEXT NOT NULL,
  status TEXT NOT NULL,  -- trial | active | grace | expired | canceled
  expires_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Current schema uses **`users.subscription_status`** default `'trial'` until Play integration ships.

## Product ID naming

- Use lowercase, stable IDs: `bradley_annual`.
- Match **applicationId** in `android/app/build.gradle` (`com.bradley.app`) in Play Console.
- Document IDs in repo (`app.json` / README) so client and server stay aligned.

## Testing with license testers

1. Play Console → **Settings → License testing** → add Gmail accounts (e.g. admin emails).
2. Upload at least one **internal testing** release with billing permission in manifest.
3. License testers can subscribe without real charges (test cards / accelerated renewals in test tracks).
4. Use **Reserved test SKUs** only if needed; prefer real product ID in internal track.
5. Verify: purchase → API verify → `subscription_status` updates → app gates premium features (TBD).

## App gating (implemented)

| `subscription_status` | Behavior |
|-------------------------|----------|
| `trial` | Full access until `subscription_trial_ends_at` (14 days from registration) |
| `active` | Full access until `subscription_expires_at` (if set) |
| `expired` / other | App shows `SubscriptionScreen`; API returns **402** on protected routes |

Both **client** and **cleaner** roles require an active trial or paid subscription — **except** cleaners invited to a home whose **owner** has active trial or paid subscription (cleaner bypass). Admin users (`ADMIN_EMAILS` / `role=admin`) bypass the gate.

### Who pays

| Role | Subscription |
|------|----------------|
| **Homeowner (client)** | $5/year after 14-day free trial |
| **Cleaner** | **Free** when joined to a home via cleaner invite and the homeowner has active trial or subscription |
| **Cleaner (no home / expired owner)** | Must subscribe or join a paying client's home |
| **Admin** | Always free |

Server logic: `resolveSubscriptionAccess()` in `server/index.js` checks `home_members` for `role = 'cleaner'`, loads each linked home's `owner_id`, and grants access when the owner's subscription resolves to `hasAccess: true` (reason: `cleaner_invited_by_paying_owner`).

### Client flow

1. After login/register, `GET /auth/me` returns `hasSubscriptionAccess`, `trialEndsAt`, `subscriptionExpiresAt`.
2. If access is denied, the app renders `SubscriptionScreen`:
   - Homeowners: “Bradley costs $5/year after your free trial…”
   - Cleaners without a paying client: prompted to join with an invite code (subscription included).
3. **Dev builds** (`__DEV__`): **Subscribe** calls `POST /subscription/activate-dev` (server allows when `NODE_ENV !== 'production'` or `BRADLEY_DEV_SUBSCRIPTION=1`).
4. **Production builds**: placeholder “Coming soon — Google Play” until billing ships.

### Server enforcement

Protected routes use `authRequired` middleware (= JWT auth + subscription check). Exempt: `/auth/register`, `/auth/login`, `/auth/me`, `/auth/push-token`, `/subscription/activate-dev`, `/health`. Admin routes still require JWT; admins bypass subscription in `resolveSubscriptionAccess`.

---

## Still needed for Google Play integration

| Item | Status |
|------|--------|
| Play Console subscription product (`bradley_annual` / $4.99) | Not created |
| `react-native-iap` (or RevenueCat) in Expo dev/production build | Not installed |
| Purchase flow in `SubscriptionScreen` (listen, finish transaction) | Not implemented |
| `POST /billing/verify` with Google Play Developer API | Not implemented |
| Service account JSON in admin settings (secure storage) | Not wired |
| Real-time Developer Notifications (RTDN) for renewals/cancellations | Not implemented |
| Restore purchases on new device | Not implemented |
| Production: disable `/subscription/activate-dev` (already gated) | Done |
| Optional `subscriptions` audit table | Schema documented below, not migrated |

### Recommended next steps

1. Create annual subscription in Play Console; add license testers.
2. Add `react-native-iap`, prebuild, internal testing track APK.
3. Implement `POST /billing/verify` per sketch below; map Play `subscriptionState` → `users.subscription_status` + `subscription_expires_at`.
4. Replace production placeholder button with Play purchase + server verify.
5. Add RTDN webhook or periodic token refresh for renewals and grace period.

## References

- [Google Play Billing](https://developer.android.com/google/play/billing)
- [Subscriptions v2 API](https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.subscriptionsv2)
- [react-native-iap](https://github.com/dooboolab-community/react-native-iap)
- [RevenueCat React Native](https://www.revenuecat.com/docs/getting-started/installation/reactnative)
