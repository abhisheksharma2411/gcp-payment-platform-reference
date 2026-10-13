/**
 * One command that injects failure: the ambiguous provider timeout, retried
 * into a second provider region. Both components are behaving correctly.
 */
import { isoOf } from '../src/clock.ts';
import { controlUnrecordedProviderEffect } from '../src/controls.ts';
import { makeClock } from '../src/clock.ts';
import { PaymentPlatform } from '../src/platform.ts';
import { ProviderSimulator } from '../src/provider.ts';
import { buildSettlementFile, ingestSettlement } from '../src/settlement.ts';
import { auditSeams } from '../src/seams.ts';
import { renderTrace } from '../src/trace.ts';

const clock = makeClock();
const provider = new ProviderSimulator();
const platform = new PaymentPlatform({ clock, provider, mutations: { failoverRegionOnRetry: true } });
platform.createIntent({
  intentId: 'int_0001', tenantId: 'tnt_alpha', channel: 'WEB_CHECKOUT', currency: 'EUR',
  allocations: [
    { allocationId: 'alloc_goods', purpose: 'goods', amountMinor: 3000 },
    { allocationId: 'alloc_shipping', purpose: 'shipping', amountMinor: 1599 },
  ],
  tokenRef: 'tok_synthetic_7f21',
});
platform.authorize({ operationId: 'op_auth_1', intentId: 'int_0001', tenantId: 'tnt_alpha', amountMinor: 4599 });
platform.capture({
  operationId: 'op_cap_1', intentId: 'int_0001', tenantId: 'tnt_alpha',
  amountMinor: 2000, scripted: 'TIMEOUT_AFTER_SEND',
});
platform.reconcileUnknown('op_cap_1');
const summary = ingestSettlement(platform, clock, buildSettlementFile(provider));

console.log(renderTrace(platform.trace, isoOf));
console.log('');
console.log(`settlement: ${summary.matched} matched, ${summary.exceptions} exception(s)`);
for (const e of platform.exceptions) console.log(`  ${e.code} ${e.providerRef}: ${e.detail}`);
console.log('');
for (const f of auditSeams(platform.trace)) console.log(`  ${f.code} ${f.subject}: ${f.detail}`);
console.log('');
console.log(`control check: ${controlUnrecordedProviderEffect().exact ? 'discriminating' : 'NOT DISCRIMINATING'}`);
