# One command runs everything. No cloud project, no credentials, no network.
#
#   make verify

NODE ?= node
NPX  ?= npx
PY   ?= python3

TESTS = tests/capability.test.ts tests/routing.test.ts tests/failover.test.ts \
        tests/health.test.ts tests/webhook.test.ts tests/negative-controls.test.ts

.PHONY: help verify test typecheck report determinism secret-scan clean

help:
	@echo "verify        run everything (no cloud project, no credentials, no network)"
	@echo "test          capability, routing, failover, health, webhooks, negative controls"
	@echo "typecheck     strict TypeScript check (needs: npm install)"
	@echo "report        run every scenario -> results/"
	@echo "determinism   fail if two report runs differ"
	@echo "secret-scan   credential scan"
	@echo "clean         remove generated results"

verify: typecheck test report determinism secret-scan
	@echo ""
	@echo "verify: PASS"

test:
	@echo "== capability, routing, failover, health, webhooks, controls =="
	$(NODE) --test $(TESTS)

typecheck:
	@echo "== strict type check =="
	@if [ -d node_modules/typescript ]; then \
		$(NPX) tsc --noEmit -p tsconfig.json && echo "typecheck: PASS"; \
	else \
		echo "typecheck: SKIPPED (run 'npm install' to enable)"; \
	fi

report:
	@echo "== routing and failover scenarios =="
	@$(NODE) scripts/report.ts > /dev/null
	@echo "wrote results/orchestration.json and results/report.md"

determinism:
	@echo "== determinism =="
	@cp results/report.md results/.report.check 2>/dev/null || true
	@$(NODE) scripts/report.ts > /dev/null
	@diff -q results/.report.check results/report.md > /dev/null \
		&& echo "determinism: PASS (byte-identical)" \
		|| (echo "determinism: FAIL"; rm -f results/.report.check; exit 1)
	@rm -f results/.report.check

secret-scan:
	@echo "== secret scan =="
	@$(PY) scripts/secret-scan.py

clean:
	rm -rf results/*.json results/*.md results/.report.check
