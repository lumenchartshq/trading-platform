import test from 'node:test';
import assert from 'node:assert/strict';
import { loadModule } from './load-module.mjs';
const { orderEditability, assertOrderModification, canModifyOrder } = await loadModule('src/core/order-modification.ts');
const { resolveCapabilities } = await loadModule('src/core/capabilities.ts');
test('broker-restricted orders hide all modification controls and reject dispatch even when global capabilities allow edits', () => {
  const order = { id:'O',symbol:'X',side:1,qty:1,type:3,status:6,stopPrice:100,extra:{lumenOrderRestrictions:{editable:false}} };
  const policy = resolveCapabilities({ configFlags: { supportModifyOrderPrice:true,supportEditAmount:true,supportModifyBrackets:true } });
  assert.equal(orderEditability({...order,extra:undefined},policy,true).price,true);
  assert.equal(canModifyOrder(orderEditability(order,policy,true)),false);
  assert.throws(() => assertOrderModification(order,{...order,stopPrice:101},policy), error => error.code === 'stale-context');
});
