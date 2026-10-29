import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BaileysStartupService } from '../src/api/integrations/channel/whatsapp/whatsapp.baileys.service';

const targetKey = {
  id: 'SYNTHETIC_MESSAGE_ID',
  remoteJid: 'synthetic-user@lid',
  fromMe: false,
  participant: 'synthetic-user@lid',
};

const storedKey = {
  ...targetKey,
  remoteJidAlt: 'synthetic-user@s.whatsapp.net',
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
  key: { ...storedKey, ...changes.key },
  message: {
    conversation: 'synthetic original',
    messageContextInfo: { messageSecret: 'secret' in changes ? changes.secret : asJsonBytes(secret) },
  },
});

test('strict edit lookup matches the protobuf identity despite stored alternate JIDs', async () => {
  const { service, queries } = serviceFor([storedRow()]);
  const result = await service.getMessageForEdit(targetKey);

  assert.equal(result.id, 'synthetic-row-id');
  assert.deepEqual(result.key, storedKey);
  assert.ok(result.message.messageContextInfo.messageSecret instanceof Uint8Array);
  assert.deepEqual(result.message.messageContextInfo.messageSecret, secret);
  assert.ok(queries[0].values.includes('synthetic-instance'));
  assert.ok(queries[0].values.includes(targetKey.id));
  assert.ok(queries[0].values.includes(targetKey.remoteJid));
  assert.ok(queries[0].values.includes('false'));
  assert.ok(queries[0].values.includes(targetKey.participant));
  assert.ok(!queries[0].values.includes(storedKey.remoteJidAlt));
  assert.ok(!queries[0].values.includes(storedKey.participantAlt));
});

test('mismatched source keys and ambiguous duplicate rows fail closed', async () => {
  for (const key of [
    { id: 'other-id' },
    { remoteJid: 'other-chat@lid' },
    { fromMe: true },
    { participant: 'other-author@lid' },
  ]) {
    const { service } = serviceFor([storedRow({ key })]);
    assert.equal(await service.getMessageForEdit(targetKey), undefined);
  }

  const { service } = serviceFor([storedRow(), storedRow()]);
  assert.equal(await service.getMessageForEdit(targetKey), undefined);

  const foreignInstance = serviceFor([storedRow()]);
  foreignInstance.service.instanceId = 'other-instance';
  assert.equal(await foreignInstance.service.getMessageForEdit(targetKey), undefined);
});

test('invalid lookup keys do not query the database and missing secrets remain missing', async () => {
  const invalid = serviceFor([storedRow()]);
  assert.equal(await invalid.service.getMessageForEdit({ ...targetKey, fromMe: undefined }), undefined);
  assert.equal(invalid.queries.length, 0);

  const missing = serviceFor([storedRow({ secret: undefined })]);
  const result = await missing.service.getMessageForEdit(targetKey);
  assert.equal(result.message.messageContextInfo.messageSecret, undefined);
});

test('MySQL uses equivalent JSON key predicates', async () => {
  const { service, queries } = serviceFor([storedRow()], 'mysql');
  assert.ok(await service.getMessageForEdit(targetKey));
  assert.match(queries[0].sql, /JSON_EXTRACT/);
  assert.ok(queries[0].values.includes('synthetic-instance'));
});
