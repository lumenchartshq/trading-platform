import assert from 'node:assert/strict';
import test from 'node:test';
import { loadModule } from './load-module.mjs';
const { NotificationLog } = await loadModule('src/core/notification-log.ts');

test('U09: interleaved notification writers share unique identities and one bounded immutable history', () => {
  const log = new NotificationLog();
  let changes = 0;
  const release = log.subscribe(() => changes++);
  const broker = { title: 'Broker', text: 'Accepted', type: 1 };
  const order = { title: 'Order executed', text: 'Buy 2 X', type: 1 };
  log.push(broker);
  const first = log.get();
  broker.text = 'Changed after publication';
  for (let i = 0; i < 205; i++) log.push(i % 2 ? broker : order);
  assert.equal(first[0].text, 'Accepted');
  assert.equal(first.length, 1);
  const current = log.get();
  assert.equal(current.length, 200);
  assert.equal(new Set(current.map(item => item.id)).size, 200);
  assert(current[0].id > first[0].id);
  assert(Object.isFrozen(current));
  assert(Object.isFrozen(current[0]));
  release(); log.push(order);
  assert.equal(changes, 206);
  const last = log.get();
  log.destroy(); log.push(order);
  assert.equal(log.get(), last);
});

test('U09: temporary toast summaries do not evict broker history', () => {
  const log = new NotificationLog();
  const event = { title: 'Order changed', text: 'Buy 2 X', type: 1 };
  for (let i = 0; i < 199; i++) log.push(event);
  log.pushBatch([event, { ...event, title: 'Protection updated', audience: 'toast' }]);
  assert.equal(log.get().filter(item => item.audience !== 'toast').length, 200);
  assert.equal(log.get()[0].id, 1);
  log.push(event);
  assert.equal(log.get().filter(item => item.audience !== 'toast').length, 200);
  assert.equal(log.get()[0].id, 2);
  assert.equal(log.get().filter(item => item.audience === 'toast').length, 1);
  for (let i = 0; i < 205; i++) log.push({ ...event, audience: 'toast' });
  assert.equal(log.get().filter(item => item.audience === 'toast').length, 200);
  assert.equal(log.get().filter(item => item.audience !== 'toast').length, 200);
  log.destroy();
});
