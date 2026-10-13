# gcp-payment-platform-reference

An integrated reference for a payment platform on Google Cloud: intent,
authorization, capture, ledger, settlement, orchestration across providers, and
dispute handling.

Local-first. Every module runs without a cloud project; optional Google Cloud
profiles are additive and never required to verify.

Part of **Building Reliable Financial Systems on Google Cloud**.

## Modules

| Module | Article | Proves |
|---|---|---|
| [`payment-platform-reference`](modules/payment-platform-reference) | 11 — Production-grade payment platform | The seams: where two individually correct components disagree, and what the end-to-end flow needs that no single article specifies |
| [`multi-provider-orchestration`](modules/multi-provider-orchestration) | 16 — Payment orchestration across providers | Failover is safe only from an outcome that proves the provider has nothing recorded; removing that one condition produces double authorizations |

Further modules are added as their articles are written. Each module is
self-contained and exposes the same entry point:

```bash
cd modules/<module>
make verify
```
