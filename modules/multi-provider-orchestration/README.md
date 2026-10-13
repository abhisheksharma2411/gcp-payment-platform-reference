# multi-provider-orchestration

Routing across payment providers, and the one boundary where failing over is
safe.

Companion lab for Article 16, *Payment Orchestration Across Multiple
Providers*.

No cloud project. No credentials. No network. `make verify` runs everything.

## The idea

An orchestrator moves work between providers. The question is when it may, and
the attractive answer — *when the attempt failed* — is wrong, because "failed"
covers two situations that differ in the only way that matters.

| attempt outcome | failover |
|---|---|
| `NOT_SENT` | **safe** — the only outcome that proves the provider has nothing recorded |
| `DECLINED` | a policy choice, not a correctness question |
| `AUTHORIZED` | nothing to fail over |
| `UNKNOWN` | **blocked** until reconciliation |

A provider that refused the connection has nothing recorded. A provider that
timed out may have authorised and lost the answer. Both look like failure.

## The result

Twenty-five operations where the first provider times out **having already
authorised**:

| unknown-outcome guard | attempts | blocked failovers | double authorizations |
|---|---:|---:|---:|
| in place | 25 | 3 | **0** |
| removed | 28 | 0 | **3** |

Three rather than 25, because the circuit breaker opened after three failures
and moved the rest away. The blast radius is the product of two guards and only
one was removed.

*Simulated result, reproducible with `make report`.*

## What a generic interface would have to erase

```
methods:               a only [wallet],  b only [bank_transfer]
currencies:            a only [GBP,USD], b only [SEK]
countries:             a only [FR,GB,US], b only [SE]
separateCapture:       a=true,  b=false
honoursIdempotencyKey: a=true,  b=false
supportsQuery:         a=true,  b=false
timeoutMs:             a=8000,  b=20000
```

Each line changes what the caller may safely do. `supportsQuery` is the sharpest:
a provider without a lookup leaves an unknown outcome unresolvable until a
statement arrives, which is why it belongs in the capability contract rather
than inside an adapter.

## Layout

```
src/capability.ts     the contract, and what it is allowed to decide
src/policy.ts         versioned, deterministic routing with a full audit
src/providers.ts      two invented providers with different capabilities
src/health.ts         circuit breaking with hysteresis and staleness
src/orchestrator.ts   routing, attempting, and the failover decision
src/webhook.ts        normalisation that keeps the provider's own code
tests/                48 tests, including 7 negative controls
scripts/report.ts     every scenario -> results/
docs/                 MODEL.md and three ADRs
```

## Running it

```
make verify     # strict typecheck, 48 tests, report, determinism, secret scan
make report     # regenerate every table above
```

## Honesty notes

- **Neither provider reproduces any real provider.** Both are invented.
- **`NOT_SENT` is assumed provable.** In reality that judgement comes from a
  client library's error type, and getting it wrong converts a safe failover
  into a double charge. The largest gap between this module and the thing it
  models; `docs/MODEL.md` says so.
- **No concurrency.** `submit` loops; nothing here shows two workers racing on
  one operation.
