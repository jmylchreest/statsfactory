# Future Ideas

Items roughly ordered by value. The default posture is free-tier-friendly;
anything that incurs additional cost is opt-in by the operator.

## Budget Monitoring, Reporting, and Notifications

Track D1/Workers free tier consumption (rows written/read, request count)
per day with configurable thresholds. Alert when approaching daily limits
so operators can react before service is disrupted. Could surface in the
dashboard and optionally push to a webhook.

## Event Sampling / Rate Limiting

Per-app configurable sampling rate (e.g. ingest 10% of events) and/or
hard rate limits. Prevents a single high-traffic app from burning through
the entire daily write budget. Essential for running multiple apps on a
shared free-tier deployment.

## Alternative Dashboard Authentication

Provide auth options beyond Cloudflare Access (Zero Trust) for operators
who self-host outside Cloudflare or prefer a different auth model. Options
to explore: basic auth, OAuth/OIDC providers, token-based auth. CF Access
remains the recommended zero-config default.

## Multi-backend Support (Turso / Generic libSQL)

Formalise Turso as a first-class backend alternative to D1. The codebase
already carries the `Database` union type and pricing research is done.
Turso's free tier (10M writes/month) is ~3x more generous than D1's
(~3M writes/month). Making backend selection a config choice lets
operators pick the best fit for their traffic.

## Data Export / Backup

Export historical event data (CSV/JSON) before retention purges it or for
migration to another backend. D1 has a 5 GB storage cap; being able to
archive data externally prevents lock-in and data loss. Could be a
dashboard action or a CLI/API endpoint.

## Functional Hydrators

Script-based event enrichment at ingest time — remote fetch (calling
external APIs for enrichment), header parsing, or other custom logic.
This is an opt-in paid-tier feature: remote fetches consume subrequests
(50/invocation on free, 1000 on paid) and add latency, so it is off by
default and only practical on Workers paid tier.
