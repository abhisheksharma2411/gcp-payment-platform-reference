# One command runs everything. No cloud project, no credentials, no network.
#
#   make verify

NODE ?= node
NPX  ?= npx
PY   ?= python3

TESTS = tests/identity.test.ts tests/lifecycle.test.ts tests/provider.test.ts \
        tests/callbacks.test.ts tests/ledger.test.ts tests/settlement.test.ts \
        tests/security.test.ts tests/seams.test.ts

.PHONY: help verify test typecheck report seams happy inject secret-scan clean

help:
	@echo "verify        run everything (no cloud project, no credentials, no network)"
	@echo "test          identity, lifecycle, provider, callbacks, ledger, settlement, security, seams"
	@echo "typecheck     strict TypeScript check (needs: npm install)"
	@echo "report        every scenario and control -> results/"
	@echo "seams         the seam gate: every control must produce its code and no others"
	@echo "happy         the complete happy path, end to end"
	@echo "inject        the ambiguous timeout retried into a second provider region"
	@echo "secret-scan   credential and account-number scan"
	@echo "clean         remove generated results"

verify: typecheck test report seams secret-scan
	@echo ""
	@echo "verify: PASS"

test:
	@echo "== identity, lifecycle, provider, callbacks, ledger, settlement, security, seams =="
	$(NODE) --test $(TESTS)

typecheck:
	@echo "== strict type check =="
	@if [ -d node_modules/typescript ]; then \
		$(NPX) tsc --noEmit -p tsconfig.json && echo "typecheck: PASS"; \
	else \
		echo "typecheck: SKIPPED (run 'npm install' to enable)"; \
	fi

report:
	@echo "== every scenario and control =="
	@$(NODE) scripts/report.ts

seams:
	@echo "== seam gate =="
	@$(NODE) scripts/seams.ts --controls

happy:
	@$(NODE) scripts/happy.ts

inject:
	@$(NODE) scripts/inject.ts

secret-scan:
	@echo "== secret scan =="
	@$(PY) scripts/secret-scan.py

clean:
	rm -rf results/*.json results/*.md results/*.txt
