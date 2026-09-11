# Operational visibility

This describes the instrumentation in the repository. Alert delivery,
provider retention, dashboards, and live collection must be configured and
verified for the deployed environment before launch.

## Existing signals

`apps/web/wrangler.jsonc` enables Workers observability for development and
production, with log head sampling set to `1` and trace head sampling to
`0.01`. Those settings request collection; they do not prove retention or
delivery for a particular account.

Application code writes JSON console messages for request failures,
maintenance sweeps, queue retries and dead letters, indexing failures,
scan outcomes, suspension, cache-purge failures, and provider errors.
Messages can include organization IDs, file IDs, queue/message identifiers,
attempt counts, operation names, and error causes. There is no unified
per-request event schema or Analytics Engine dataset in this layer.

Treat log access as access to operational customer metadata. Error causes
are not passed through a universal redaction layer; inspect actual provider
and platform logging behavior before making privacy-policy claims. Do not
paste cookies, API keys, signed URLs, database credentials, or raw provider
responses into tickets or reports. Confirm the account's retention, access,
and export settings and document those actual settings in the privacy policy.

Dead letters are recorded in Postgres `failed_jobs`; authorized owners can
inspect their org's failures and operators can review failures in `/admin`.
`ALERT_WEBHOOK_URL` optionally receives a batch summary containing queue,
count, job kinds, and organization IDs. A failure to deliver that webhook
is logged; it is not itself a durable alert-delivery system.

The backup host independently records `last-run.json`, logs, and manifests,
and can send failure/shrinkage alerts using its own `ALERT_WEBHOOK_URL`.
See [backup and restore](backup-restore.md) for retention and restore limits.

## Alerts to configure before launch

- Monitor Worker failures and HTTP 5xx rates, plus an external HTTPS probe
  of the dashboard and a disposable tenant content host. An external
  status page should remain reachable during a Worker or Cloudflare outage.
- Alert on dead-letter arrivals and any parked-queue backlog. The DLQ has
  an automatic consumer, so depth alone can miss failures already persisted
  into `failed_jobs`. Parked messages expire after 14 days; follow the
  recovery procedure in [release operations](release.md#queues).
- Monitor overdue indexing, purge, scan, and usage reconciliation work as
  well as `scheduled lifecycle task failed` messages. A successful cron
  response can include an individually failed task that will retry later.
- Monitor backup status from outside the backup job: require `status: ok`
  and an age below 26 hours. The backup job cannot alert when its host is
  offline or cron never starts it. Test the independent alert receiver.

Choose thresholds and destinations appropriate to the actual traffic and
record them with the deployment. Exercise each alert with disposable data
or the provider's test function in the isolated rehearsal environment;
record the resulting notification and recovery action. Repository tests
and configured bindings do not demonstrate that an operator receives alerts.
