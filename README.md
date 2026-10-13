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
| `payment-platform-reference` | 11 | One synthetic payment from request through provider effect, ledger posting, settlement evidence and reconciliation, audited by twelve cross-component seam checks with one negative control each |

Further modules are added as their articles are written. Each module is
self-contained and exposes the same entry point:

```bash
cd modules/<module>
make verify
```
