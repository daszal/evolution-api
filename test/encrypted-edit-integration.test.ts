import assert from 'node:assert/strict';
import { test } from 'node:test';
import { postgresClient } from '../src/api/integrations/chatbot/chatwoot/libs/postgres.client';
import { BaileysStartupService } from '../src/api/integrations/channel/whatsapp/whatsapp.baileys.service';
import { Events } from '../src/api/types/wa.types';

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

test('edit lookup searches by active instance and ID, then matches the received conversation identity', async () => {
  const { service, queries } = serviceFor([storedRow()]);
  const result = await service.getMessageForEdit(targetKey);

  assert.equal(result.id, 'synthetic-row-id');
  assert.deepEqual(result.key, storedKey);
  assert.ok(result.message.messageContextInfo.messageSecret instanceof Uint8Array);
  assert.deepEqual(result.message.messageContextInfo.messageSecret, secret);
  assert.ok(queries[0].values.includes('synthetic-instance'));
  assert.ok(queries[0].values.includes(targetKey.id));
  assert.ok(!queries[0].values.includes(targetKey.remoteJid));
  assert.ok(!queries[0].values.includes('false'));
  assert.ok(!queries[0].values.includes(targetKey.participant));
  assert.ok(!queries[0].values.includes(storedKey.remoteJidAlt));
  assert.ok(!queries[0].values.includes(storedKey.participantAlt));
  assert.doesNotMatch(queries[0].sql, /JSON_EXTRACT\(`key`, '\$\.(remoteJid|fromMe|participant)'/);
  assert.doesNotMatch(queries[0].sql, /"key"->>'(remoteJid|fromMe|participant)'/);
});

test('an ID collision in another chat is filtered by the authenticated received identity', async () => {
  const wrongChat = storedRow({ key: { remoteJid: 'other-user@lid' } });
  const { service } = serviceFor([wrongChat, storedRow()]);
  const result = await service.getMessageForEdit(targetKey);

  assert.equal(result.id, 'synthetic-row-id');
  assert.deepEqual(result.key, storedKey);
});

test('direct LID/PN representations require reciprocal received alternate metadata', async () => {
  const received = {
    ...targetKey,
    remoteJid: 'synthetic-user@s.whatsapp.net',
    remoteJidAlt: 'synthetic-user@lid',
  };
  const originalLidKey = {
    ...storedKey,
    remoteJid: 'synthetic-user@lid',
    remoteJidAlt: 'synthetic-user@s.whatsapp.net',
  };
  const { service } = serviceFor([storedRow({ key: originalLidKey })]);
  const result = await service.getMessageForEdit(received);
  assert.deepEqual(result.key, originalLidKey);

  const noReciprocal = serviceFor([storedRow({ key: originalLidKey })]);
  assert.equal(await noReciprocal.service.getMessageForEdit({ ...received, remoteJidAlt: undefined }), undefined);
});

test('wrong ID, chat, direction, duplicate eligible rows and foreign instances fail closed', async () => {
  for (const key of [
    { id: 'other-id' },
    { remoteJid: 'other-chat@lid' },
    { fromMe: true },
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

test('a group edit from a different participant is rejected', async () => {
  const groupKey = {
    ...targetKey,
    remoteJid: 'synthetic-group@g.us',
    participant: 'synthetic-author@lid',
  };
  const wrongSender = storedRow({
    key: { remoteJid: groupKey.remoteJid, participant: 'other-author@lid' },
  });
  const { service } = serviceFor([wrongSender]);
  assert.equal(await service.getMessageForEdit(groupKey), undefined);
});

test('group LID/PN sender identity requires a reciprocal participant alternate', async () => {
  const received = {
    ...targetKey,
    remoteJid: 'synthetic-group@g.us',
    participant: 'synthetic-author@s.whatsapp.net',
    participantAlt: 'synthetic-author@lid',
  };
  const originalLidKey = {
    ...storedKey,
    remoteJid: 'synthetic-group@g.us',
    participant: 'synthetic-author@lid',
    participantAlt: 'synthetic-author@s.whatsapp.net',
  };
  const { service } = serviceFor([storedRow({ key: originalLidKey })]);
  const result = await service.getMessageForEdit(received);
  assert.deepEqual(result.key, originalLidKey);
});

test('invalid lookup keys do not query the database and missing secrets remain missing', async () => {
  const invalid = serviceFor([storedRow()]);
  assert.equal(await invalid.service.getMessageForEdit({ ...targetKey, id: undefined }), undefined);
  assert.equal(await invalid.service.getMessageForEdit({ ...targetKey, fromMe: undefined }), undefined);
  assert.equal(await invalid.service.getMessageForEdit({
    ...targetKey,
    remoteJid: 'synthetic-group@g.us',
    participant: undefined,
  }), undefined);
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
  assert.ok(queries[0].values.includes(targetKey.id));
  assert.ok(!queries[0].values.includes(targetKey.remoteJid));
  assert.doesNotMatch(queries[0].sql, /JSON_EXTRACT\(`key`, '\$\.(remoteJid|fromMe|participant)'/);
});

test('an accepted edit emits the original key without rewriting its original timestamp', async () => {
  const originalRow = { ...storedRow(), messageTimestamp: 1_793_000_000 };
  const eventCalls: unknown[][] = [];
  const updateRows: any[] = [];
  const databaseUpdates: any[] = [];
  const config = {
    get: (key: string) => {
      if (key === 'DATABASE') {
        return {
          PROVIDER: 'postgresql',
          SAVE_DATA: { MESSAGE_UPDATE: true, HISTORIC: false, NEW_MESSAGE: false },
        };
      }
      if (key === 'CHATWOOT') return { ENABLED: false };
      if (key === 'LOG') return { BAILEYS: 'error' };
      return {};
    },
  };
  const repository = {
    $queryRaw: async () => [originalRow],
    messageUpdate: { create: async (input: any) => updateRows.push(input.data) },
    message: { update: async (input: any) => databaseUpdates.push(input) },
  };
  const cache = { get: async () => undefined, set: async () => undefined };
  const previousConnection = postgresClient.getChatwootConnection;
  postgresClient.getChatwootConnection = (() => ({})) as any;

  let service: any;
  try {
    service = new (BaileysStartupService as any)(config, {}, repository, {}, {}, cache, {});
  } finally {
    postgresClient.getChatwootConnection = previousConnection;
  }
  service.instanceId = 'synthetic-instance';
  service.logger = { verbose: () => {}, info: () => {}, warn: () => {}, error: () => {}, log: () => {} };
  service.sendDataWebhook = async (...args: unknown[]) => eventCalls.push(args);

  const editedMessage = { editedMessage: { message: { conversation: 'synthetic edited body' } } };
  await service.messageHandle['messages.update'](
    [
      {
        key: { ...storedKey },
        update: { message: editedMessage, messageTimestamp: 1_793_300_000 },
      },
    ],
    {},
  );

  assert.equal(eventCalls.length, 1);
  assert.equal(eventCalls[0][0], Events.MESSAGES_UPDATE);
  assert.deepEqual(eventCalls[0][1], {
    keyId: targetKey.id,
    remoteJid: storedKey.remoteJid,
    fromMe: storedKey.fromMe,
    participant: storedKey.participant,
    status: 'EDITED',
    pollUpdates: undefined,
    instanceId: 'synthetic-instance',
    message: editedMessage,
    messageId: 'synthetic-row-id',
  });
  assert.equal('messageTimestamp' in (eventCalls[0][1] as object), false);
  assert.equal(originalRow.messageTimestamp, 1_793_000_000);
  assert.equal(databaseUpdates.length, 0);
  assert.equal(updateRows.length, 1);
  assert.equal('message' in updateRows[0], false);
});
