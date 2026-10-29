import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BaileysStartupService } from '../src/api/integrations/channel/whatsapp/whatsapp.baileys.service';

const originalKey = {
  id: 'SYNTHETIC_MESSAGE_ID',
  remoteJid: 'synthetic-user@lid',
  remoteJidAlt: 'synthetic-user@s.whatsapp.net',
  fromMe: false,
  participant: 'synthetic-user@lid',
  participantAlt: 'synthetic-user@s.whatsapp.net',
};

const secret = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const asJsonBytes = (bytes: Uint8Array) => Object.fromEntries(Array.from(bytes, (byte, index) => [index, byte]));

function serviceFor(rows: any[], provider = 'postgresql') {
  const queries: Array<{ sql: string; values: unknown[] }> = [];
  const service: any = Object.create(BaileysStartupService.prototype);
  service.instance = {};
  service.instanceId = 'synthetic-instance';
  service.configService = { get: () => ({ PROVIDER: provider }) };
  service.prismaRepository = {
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      queries.push({ sql: strings.join('?'), values });
      return rows;
    },
  };
  return { service, queries };
}

const storedRow = (changes: { key?: Record<string, unknown>; secret?: unknown } = {}) => ({
  id: 'synthetic-row-id',
  instanceId: 'synthetic-instance',
  key: { ...originalKey, ...changes.key },
  message: {
    conversation: 'synthetic original',
    messageContextInfo: { messageSecret: 'secret' in changes ? changes.secret : asJsonBytes(secret) },
  },
});

test('strict edit lookup scopes instance, ID, chat, direction and participant, then decodes stored bytes', async () => {
  const { service, queries } = serviceFor([storedRow()]);
  const result = await service.getMessageForEdit(originalKey);

  assert.equal(result.id, 'synthetic-row-id');
  assert.deepEqual(result.key, originalKey);
  assert.ok(result.message.messageContextInfo.messageSecret instanceof Uint8Array);
  assert.deepEqual(result.message.messageContextInfo.messageSecret, secret);
  assert.ok(queries[0].values.includes('synthetic-instance'));
  assert.ok(queries[0].values.includes(originalKey.id));
  assert.ok(queries[0].values.includes(originalKey.remoteJid));
  assert.ok(queries[0].values.includes('false'));
  assert.ok(queries[0].values.includes(originalKey.participant));
  assert.ok(queries[0].values.includes(originalKey.remoteJidAlt));
  assert.ok(queries[0].values.includes(originalKey.participantAlt));
});

test('mismatched source keys and ambiguous duplicate rows fail closed', async () => {
  for (const key of [
    { id: 'other-id' },
    { remoteJid: 'other-chat@lid' },
    { fromMe: true },
    { participant: 'other-author@lid' },
    { remoteJidAlt: 'unmapped@s.whatsapp.net' },
    { participantAlt: 'unmapped@s.whatsapp.net' },
  ]) {
    const { service } = serviceFor([storedRow({ key })]);
    assert.equal(await service.getMessageForEdit(originalKey), undefined);
  }

  const { service } = serviceFor([storedRow(), storedRow()]);
  assert.equal(await service.getMessageForEdit(originalKey), undefined);

  const foreignInstance = serviceFor([storedRow()]);
  foreignInstance.service.instanceId = 'other-instance';
  assert.equal(await foreignInstance.service.getMessageForEdit(originalKey), undefined);
});

test('invalid lookup keys do not query the database and missing secrets remain missing', async () => {
  const invalid = serviceFor([storedRow()]);
  assert.equal(await invalid.service.getMessageForEdit({ ...originalKey, fromMe: undefined }), undefined);
  assert.equal(invalid.queries.length, 0);

  const missing = serviceFor([storedRow({ secret: undefined })]);
  const result = await missing.service.getMessageForEdit(originalKey);
  assert.equal(result.message.messageContextInfo.messageSecret, undefined);
});

test('MySQL uses equivalent JSON key predicates', async () => {
  const { service, queries } = serviceFor([storedRow()], 'mysql');
  assert.ok(await service.getMessageForEdit(originalKey));
  assert.match(queries[0].sql, /JSON_EXTRACT/);
  assert.ok(queries[0].values.includes('synthetic-instance'));
});
