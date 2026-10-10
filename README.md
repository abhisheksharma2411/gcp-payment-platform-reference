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

Further modules are added as their articles are written. Each module is
self-contained and exposes the same entry point:

```bash
cd modules/<module>
make verify
```
