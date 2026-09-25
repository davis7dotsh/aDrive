# Billing provider contract

Autumn customers use the aDrive organization ID. `apps/web/autumn.config.ts`
defines Free (2 GiB, 500 AI operations) and Pro ($8/month, 100 GiB, 10,000 AI
operations). Public sharing exists on both plans; verified identity and the
application's trust gates determine eligibility.

AI allowances reset at the start of each UTC calendar month. Stripe's
subscription billing date is separate from that allowance window. Postgres
is authoritative for stored bytes and AI usage; local reservations enforce
AI limits before embedding work starts.

## Usage synchronization

The application sends absolute usage with `balances.update`, including
`interval: 'month'` and the next UTC month's timestamp in `nextResetAt` for AI
operations. Repeated delivery of the same usage does not consume another
allowance. Writes are serialized per organization; durable reconciliation
work and the scheduled sweep repair interrupted deliveries and resubmit
current counters. An old request that completes late at the provider can
briefly leave its copy stale; the next reconciliation restores current
usage. The local counters continue to enforce quotas.

Do not switch this to additive `track` calls with automatic acknowledgement
of duplicate HTTP 409 responses. Autumn's request idempotency key is claimed
before the operation completes, and the documented default key lifetime is
24 hours. A duplicate acknowledgement therefore does not prove completed
metering, and retries after expiry can add usage twice.

The SDK has `failOpen: false`. Only permission checks explicitly fail open
on provider failure. Customer creation, balance synchronization, checkout,
portal creation, and subscription reads return errors on failure. Every HTTP
request, including reading its response body, has a five-second deadline;
responses larger than 2 MiB are rejected. SDK retries are disabled so the
application owns recovery and a provider outage cannot hold a transaction
open indefinitely.

## Subscription changes and checkout

The signed `billing.updated` webhook is a reconciliation signal.
`plan_changes` lists only the plans affected by an event, so it cannot be
used as a complete subscription snapshot. The handler locks the organization
row before fetching the current customer subscriptions and updating the
local plan. Unknown customers and entity-scoped events are acknowledged
without modifying an organization. Provider failure retains the existing
plan and returns an error so Svix retries.

Active customer-level Pro subscriptions retain Pro access, including trials,
cancellation at period end, and the provider's default past-due grace state.
Scheduled, expired, and entity-scoped subscriptions do not grant Pro to the
organization. Webhook redelivery fetches the latest state each time.

Checkout uses `redirectMode: 'always'` so an owner reviews the hosted payment
flow even when a payment method is already saved. A missing URL from a
configured provider is an error; it is not evidence that a plan changed.

## Configuration and validation

Set both `AUTUMN_SECRET_KEY` and `AUTUMN_WEBHOOK_SECRET` for live billing.
Without an API key, external billing is disabled and local quotas remain in
force. A configured webhook cannot infer a plan without an API key. Keys
starting with `fake:` are accepted only in development, including when the
client is constructed directly.

Provider tests exercise the real installed SDK against intercepted HTTP
responses, including failures, stalled bodies, cancellation, calendar usage
payloads, subscription states, and checkout behavior. Postgres tests cover
serialized webhook reconciliation; route tests cover signed delivery and
redelivery. These do not establish live Autumn, Stripe, or Svix behavior;
verify those integrations in their sandbox before production cutover.

References:

- [Autumn Update Balance API](https://docs.useautumn.com/api-reference/balances/updateBalance)
- [Autumn payment flow](https://docs.useautumn.com/documentation/customers/payment-flow)
- [Autumn billing reliability and idempotency](https://docs.useautumn.com/documentation/customers/edge-cases)
- [Autumn webhooks](https://docs.useautumn.com/documentation/webhooks)
- [Provider request idempotency implementation](https://github.com/useautumn/autumn/blob/main/server/src/internal/misc/idempotency/withIdempotencyKey.ts)
