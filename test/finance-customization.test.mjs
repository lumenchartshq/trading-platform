import { mapSettings, simulatedSession } from './support/session-fixture.mjs';
// Group D: finance and broker customization behaviors driven through the public session and ticket controller.
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadModule } from './load-module.mjs';
import { flush } from './manual-clock.mjs';
const { createTicketController } = await loadModule('src/ui/order-ticket/controller.ts');
const { resolveCapabilities, cryptoTicketMode } = await loadModule('src/core/capabilities.ts');
const { ConnectionStatus, DisconnectType, Side, OrderType } = await loadModule('src/contracts/broker.ts');
async function fixture(configure, settings = new Map()) {
  const f = await simulatedSession({ configureBroker: configure, options: { settings: mapSettings(settings) } });
  return { ...f, host: () => f.host, settings };
}
const binding = { id: 'C', generation: 1, symbol: 'SIM:X' };

test('U01/P04: a symbol crypto-exchange setting overrides broker-wide and per-type crypto ticket modes', () => {
  const policy = (flags, symbol) => ({ ...resolveCapabilities({ configFlags: flags }), symbol: symbol ?? {} });
  assert.equal(cryptoTicketMode(policy({ supportCryptoExchangeOrderTicket: true }, { supportCryptoExchange: false })), false);
  assert.equal(cryptoTicketMode(policy({}, { supportCryptoExchange: true }), 'stock'), true);
  assert.equal(cryptoTicketMode(policy({ supportSymbolSpecificCryptoOrderTicket: true }), 'crypto'), true);
  assert.equal(cryptoTicketMode(policy({ supportSymbolSpecificCryptoOrderTicket: true }), 'forex'), false);
});

test('U03: saveToSettings custom fields restore the last value for the next ticket; masked fields never persist', async () => {
  const fields = [
    { id: 'note', title: 'Note', inputType: 'TextField', value: '', saveToSettings: true, placeHolder: 'Optional note' },
    { id: 'pin', title: 'PIN', inputType: 'TextField', value: '', saveToSettings: true, maskWithAsterisk: true },
    { id: 'tag', title: 'Tag', inputType: 'TextField', value: 'default' },
  ];
  const f = await fixture((broker) => { broker.getOrderDialogOptions = async () => ({ customFields: fields }); });
  const ticket = createTicketController(f.session);
  try {
    await ticket.open(binding, { side: Side.Buy, type: OrderType.Limit, limitPrice: 99 });
    assert.equal(ticket.state.get().options.customFields[0].placeHolder, 'Optional note');
    ticket.patch({ customFields: { note: 'swing', pin: '1234', tag: 'other' } });
    assert.deepEqual([...f.settings.values()], [JSON.stringify('swing')], 'only the unmasked opted-in field is stored');
    ticket.close();
    await ticket.open(binding, { side: Side.Buy, type: OrderType.Limit, limitPrice: 99 });
    assert.deepEqual(ticket.state.get().order.customFields, { note: 'swing', pin: '', tag: 'default' });
  } finally { ticket.destroy(); f.session.destroy(); }
});

test('B04/P03: an order template with exit levels in pips and parent-price percent opens with resolved prices', async () => {
  const f = await fixture();
  const ticket = createTicketController(f.session);
  try {
    await ticket.open(binding, { side: Side.Buy, type: OrderType.Limit, limitPrice: 100, qty: 4, exitLevels: [{ id: 'one', qty: 3, tpPips: 50, slParentPricePercent: 1 }] });
    const [level] = ticket.state.get().order.exitLevels;
    assert.equal(level.takeProfit, 100.5);
    assert.equal(level.stopLoss, 99);
    assert.equal('tpPips' in level, false, 'template fields never reach the broker payload');
  } finally { ticket.destroy(); f.session.destroy(); }
});

test('A02: disconnection details are kept as bounded display text and cleared on reconnect', async () => {
  const f = await fixture();
  try {
    f.simulation.controls.disconnect();
    assert.equal(f.session.state.connection.get().notice, undefined, 'no details without broker info');
    f.host().connectionStatusUpdate(ConnectionStatus.Disconnected, { heading: 'Session ended', message: 'Sign in again to trade.', additionalInfo: 'x'.repeat(900), disconnectType: DisconnectType.LogOut, reason: 2 });
    const notice = f.session.state.connection.get().notice;
    assert.equal(notice.heading, 'Session ended'); assert.equal(notice.message, 'Sign in again to trade.');
    assert.equal(notice.additionalInfo.length, 500); assert.equal(notice.disconnectType, DisconnectType.LogOut);
    assert.equal('reason' in notice, false, 'the analytics-only reason is not retained');
    f.simulation.controls.reconnect(); await flush(); await flush();
    assert.equal(f.session.state.connection.get().notice, undefined);
  } finally { f.session.destroy(); }
});
