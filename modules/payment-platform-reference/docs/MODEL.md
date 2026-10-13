# What this module models, and where it departs from Google Cloud

This module is a local, deterministic representation of a payment platform:
three channels, a command API, a provider adapter with regional endpoints, a
durable operation store, lifecycle events, a double-entry ledger, a settlement
ingest, a reconciliation exception path, an audit timeline and a seam auditor.
It is not a Google Cloud client and it is not a payment integration. It opens
no connection, holds no credential, needs no project, and never touches a card
number.

That buys determinism and costs fidelity. This page records what was kept and
what was not, so nothing here is mistaken for a description of how the platform
or any provider behaves.

## Mechanisms represented

| Mechanism | Modelled as | Faithful in | Simplified in |
|---|---|---|---|
| Command API | `PaymentPlatform.authorize/capture/refund/reverse` | caller-chosen operation id, request fingerprint, replay and conflict | no HTTP, no headers, no authentication, no rate limiting |
| Operation store | `operations` map | one state machine per operation, declared transitions, terminal states | a map, not a database; no transactions, no leases, no timers |
| Provider adapter | `ProviderSimulator` | per-region idempotency keys, four scripted outcomes, two accounting rules | one provider, one API shape, no network, no authentication, no 3-D Secure |
| Ambiguous outcome | `TIMEOUT_AFTER_SEND` | the effect exists and the caller never hears of it | injected, never spontaneous |
| Provider callback | `handleCallback` | duplicate and conflicting callbacks, order-independence, the join to an operation | no signature verification, no HTTP, no retry schedule |
| Lifecycle events | `event` trace entries | one durable record per transition, with a sequence | no broker, no topic, no subscription, no delivery; Article 17 owns that |
| Ledger | `Ledger` | immutable postings, balanced leg sets, derived balances | no database, no currency table, no period close; Article 14 owns the real design |
| Settlement | `buildSettlementFile` / `ingestSettlement` | the file is built from the provider's truth, matched against the platform's | one file format, one fee basis, no bank deposit, no timing; Article 19 owns that |
| Reporting copy | `readReporting` | a declared staleness and a declared window | a lag constant, not a replica |
| Audit timeline | `timelineFor` | assembled from references only, resolvable outside the card-data boundary | not persisted, not access-controlled |
| Tenancy | `tenantId` comparison | a command or read for another tenant is refused | a string comparison, not IAM, not a VPC perimeter |

## Departures, stated plainly

**There is no concurrency.** One process, one thread, no interleaving. "Two
concurrent attempts against one intent" is two sequential calls, and the second
is refused by an amount guard that reads a field the first has already written.
In a real platform that pair has to be one read-write transaction, and this
module cannot demonstrate that it is. Nothing here exercises a lock, a lease or
an aborted transaction.

**Time is a counter.** `makeClock` advances one millisecond per read and
whatever a scenario asks for. There is no wall clock anywhere in `src/`, which
is what makes `make report` byte-identical across runs. It also means the
stale-read check compares two numbers this module chose, not two timestamps two
replicas produced.

**The reporting lag is a constant, not a replica.** The 15-second window in the
authority map comes from Spanner's own guidance for multi-region reads. The
2-millisecond default lag in the model is arbitrary and exists only so that a
compliant read and a non-compliant one are distinguishable.

**The provider is one provider.** Its idempotency-key scope, its accounting
rules and its callback shape are modelled on published documentation from
Adyen and Stripe, and they differ between providers in ways this module does
not represent: key retention differs (Stripe's page describes removing keys
after at least 24 hours; Adyen's describes 7 to 14 days), error taxonomies
differ, and partial-capture support differs. A platform integrating several
providers has a normalisation problem this module does not have.

**Regional failover is a parameter, not a mechanism.** `failoverRegionOnRetry`
sends one retry to a second endpoint. There is no health check, no load
balancer, no DNS, no quorum, and no Spanner. Article 3 owns multi-region
authority; this module uses a single boolean to reach the consequence.

**A restart preserves everything durable and nothing else.** `resumeFrom`
copies the operation records, the intents, the join index, the ledger and the
trace into a new platform object. A real restart loses in-flight work in ways
this does not model: a half-written transaction, a lease still held by a dead
process, a task already dispatched.

**Settlement has no timing.** Real files arrive days later, cover a period, can
be restated, and carry fees that are not a fixed basis-point cut. This one is
generated from the provider's records at the moment of ingest.

**The cardholder-data boundary is a shape check.** `S09` looks for a 13-to-19
digit run written by a component other than the vault. It is not tokenisation,
not encryption, not a perimeter, and not scope reduction. Article 20 owns the
real boundary. The synthetic value used by the leak control is deliberately not
Luhn-valid so that the repository's own account-number scan stays meaningful;
test `S06` pins that.

**No cost figure appears anywhere.** No pricing page was read. The only sourced
cost statement in the article is directional, from Spanner's own configuration
trade-off table.

**The auditor has never been pointed at a real trace.** Its portability — that
the same twelve checks would run over records assembled from Cloud Logging or a
BigQuery table — is an argument about its interface, not a result. The first
real trace will be missing a field the checks assume.

## What the module deliberately does not contain

Fraud scoring, 3-D Secure, dispute handling, payouts, multi-currency
conversion, network tokens, stored-credential sequencing, provider routing
across more than one provider, and anything resembling a real card number. The
first two are Articles 8 and 15; the dispute path is Article 21.
