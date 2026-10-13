# What this module models, and where it departs from reality

This module is a local, deterministic representation of multi-provider payment
orchestration. It is not a client for any payment provider, reaches no network,
and needs no cloud project.

**Neither simulated provider reproduces any real provider's API, response
codes, capabilities, fees or behaviour.** `acquirer-a` and `acquirer-b` are
invented, and they differ along the dimensions the article argues a generic
interface must not erase.

## Mechanisms represented

| Mechanism | Modelled as | Faithful in | Simplified in |
|---|---|---|---|
| Capability contract | `src/capability.ts` | methods, currencies, countries, separate capture, refunds, token portability, key handling, query support, timeout — checked before health, first failing dimension reported | no fee schedules, no settlement timing, no scheme-level rules |
| Routing policy | `src/policy.ts` | versioned, deterministic, independent of registry order, every candidate recorded with a reason | a single cost weight; no regulatory, merchant-account or performance inputs |
| Circuit breaking | `src/health.ts` | consecutive-failure opening, clock-driven half-open, hysteresis on close, stale observations discarded | no partial-open rate limiting, no per-method circuits |
| Provider idempotency | `src/providers.ts` | a repeated key returns the first result where the contract honours keys; a timed-out call still happened at the provider | no key retention limit, no provider-side expiry |
| Webhook normalisation | `src/webhook.ts` | de-duplication on `(provider, eventId)`, raw code preserved beside the normalised reason | no signature verification, no ordering, no retry schedule |

## Departures, stated plainly

**Attempts are synchronous and sequential.** `submit` loops. There is no
concurrency, so nothing here demonstrates two workers racing on one operation.
A real implementation needs the claim-and-attempt step to be atomic, and this
module cannot show that it is.

**The provider remembers keys forever.** Real providers do not. A key that has
aged out at the provider is the same problem one layer further out, and the
module does not model it.

**`NOT_SENT` is assumed to be provable.** The module hands back a transport
refusal the caller can trust. In reality the distinction between "the
connection was refused" and "the request was sent and the response was lost" is
itself a judgement, made from a client library's error type, and getting it
wrong converts a safe failover into a double charge. **This is the single
largest gap between the module and the thing it models**, and the article says
so.

**Health is per provider, not per method or region.** A provider failing only
on one payment method opens for everything here.

**No token vault.** `tokensPortable` appears in the capability contract and the
article discusses token ownership, but the module stores no tokens and performs
no migration. Nothing here demonstrates a vault.

**No settlement.** Article 19 owns settlement and reconciliation; this module
ends at the authorization outcome and the reconciliation *handle*.

**Time is a parameter, never a clock.** Every function that needs the time
takes `nowMs`. There is no `Date.now()` in `src/`, which is why `make report`
produces identical bytes on every run and `make determinism` enforces it.

## Reproducing

```
make verify     # typecheck, 48 tests, report, determinism, secret scan
make report     # regenerate results/
```

Node 22.18 or newer. `npm install` is optional and only enables the typecheck.
