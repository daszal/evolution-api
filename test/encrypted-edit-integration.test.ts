import assert from 'node:assert/strict';
import { test } from 'node:test';
import { proto } from 'baileys';
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
  const result = await service.getMessageForEncryptedEdit(targetKey);

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

test('plaintext edit lookup retains exact canonical identity predicates', async () => {
  const { service, queries } = serviceFor([storedRow()]);
  const result = await service.getMessageForEdit(targetKey);

  assert.equal(result.id, 'synthetic-row-id');
  assert.ok(queries[0].values.includes(targetKey.remoteJid));
  assert.ok(queries[0].values.includes(String(targetKey.fromMe)));
  assert.ok(queries[0].values.includes(targetKey.participant));
  assert.match(queries[0].sql, /LIMIT 2/);

  const alternateOnly = serviceFor([storedRow()]);
  assert.equal(
    await alternateOnly.service.getMessageForEdit({
      ...targetKey,
      remoteJid: 'synthetic-user@s.whatsapp.net',
      remoteJidAlt: 'synthetic-user@lid',
    }),
    undefined,
  );
});

test('an ID collision in another chat is filtered by the authenticated received identity', async () => {
  const wrongChat = storedRow({ key: { remoteJid: 'other-user@lid' } });
  const { service } = serviceFor([wrongChat, storedRow()]);
  const result = await service.getMessageForEncryptedEdit(targetKey);

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
  const result = await service.getMessageForEncryptedEdit(received);
  assert.deepEqual(result.key, originalLidKey);

  const noReciprocal = serviceFor([storedRow({ key: originalLidKey })]);
  assert.equal(await noReciprocal.service.getMessageForEncryptedEdit({ ...received, remoteJidAlt: undefined }), undefined);
});

test('wrong ID, chat, direction, duplicate eligible rows and foreign instances fail closed', async () => {
  for (const key of [
    { id: 'other-id' },
    { remoteJid: 'other-chat@lid' },
    { fromMe: true },
  ]) {
    const { service } = serviceFor([storedRow({ key })]);
    assert.equal(await service.getMessageForEncryptedEdit(targetKey), undefined);
  }

  const { service } = serviceFor([storedRow(), storedRow()]);
  assert.equal(await service.getMessageForEncryptedEdit(targetKey), undefined);

  const foreignInstance = serviceFor([storedRow()]);
  foreignInstance.service.instanceId = 'other-instance';
  assert.equal(await foreignInstance.service.getMessageForEncryptedEdit(targetKey), undefined);
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
  assert.equal(await service.getMessageForEncryptedEdit(groupKey), undefined);
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
  const result = await service.getMessageForEncryptedEdit(received);
  assert.deepEqual(result.key, originalLidKey);
});

test('invalid lookup keys do not query the database and missing secrets remain missing', async () => {
  const invalid = serviceFor([storedRow()]);
  assert.equal(await invalid.service.getMessageForEncryptedEdit({ ...targetKey, id: undefined }), undefined);
  assert.equal(await invalid.service.getMessageForEncryptedEdit({ ...targetKey, fromMe: undefined }), undefined);
  assert.equal(await invalid.service.getMessageForEncryptedEdit({
    ...targetKey,
    remoteJid: 'synthetic-group@g.us',
    participant: undefined,
  }), undefined);
  assert.equal(invalid.queries.length, 0);

  const missing = serviceFor([storedRow({ secret: undefined })]);
  const result = await missing.service.getMessageForEncryptedEdit(targetKey);
  assert.equal(result.message.messageContextInfo.messageSecret, undefined);
});

test('MySQL uses equivalent JSON key predicates', async () => {
  const { service, queries } = serviceFor([storedRow()], 'mysql');
  assert.ok(await service.getMessageForEncryptedEdit(targetKey));
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

test('Delete for Everyone resolves by active instance, target ID and verified direct conversation identity', async () => {
  const notificationKey = { ...targetKey, fromMe: false };
  const revokeTargetKey = {
    id: targetKey.id,
    remoteJid: 'synthetic-self@lid',
    fromMe: true,
  };
  const { service, queries } = serviceFor([storedRow()]);
  const result = await service.getMessageForDeletion(notificationKey, revokeTargetKey);

  assert.equal(result.result, 'matched');
  assert.equal(result.message.id, 'synthetic-row-id');
  assert.deepEqual(result.message.key, storedKey);
  assert.ok(queries[0].values.includes('synthetic-instance'));
  assert.ok(queries[0].values.includes(targetKey.id));
  assert.ok(!queries[0].values.includes(notificationKey.remoteJid));
  assert.ok(!queries[0].values.includes(revokeTargetKey.remoteJid));

  const alternateIdentity = serviceFor([storedRow({
    key: {
      remoteJid: 'synthetic-user@s.whatsapp.net',
      remoteJidAlt: 'synthetic-user@lid',
      participant: undefined,
      participantAlt: undefined,
    },
  })]);
  const lidNotification = {
    ...notificationKey,
    remoteJid: 'synthetic-user@lid',
    remoteJidAlt: 'synthetic-user@s.whatsapp.net',
    participant: undefined,
    participantAlt: undefined,
  };
  assert.equal(
    (await alternateIdentity.service.getMessageForDeletion(lidNotification, revokeTargetKey)).result,
    'matched',
  );

  const wrongSender = serviceFor([storedRow()]);
  assert.equal(
    (await wrongSender.service.getMessageForDeletion(
      { ...notificationKey, fromMe: true },
      revokeTargetKey,
    )).result,
    'missing',
  );
});

test('Delete for Everyone supports a group admin revoke by matching the embedded original author', async () => {
  const notificationKey = {
    id: targetKey.id,
    remoteJid: 'synthetic-group@g.us',
    fromMe: false,
    participant: 'synthetic-admin@lid',
  };
  const revokeTargetKey = {
    ...notificationKey,
    fromMe: true,
    participant: 'synthetic-author@lid',
  };
  const originalKey = {
    ...storedKey,
    remoteJid: notificationKey.remoteJid,
    participant: revokeTargetKey.participant,
    participantAlt: 'synthetic-author@s.whatsapp.net',
  };
  const { service } = serviceFor([storedRow({ key: originalKey })]);

  const result = await service.getMessageForDeletion(notificationKey, revokeTargetKey);
  assert.equal(result.result, 'matched');
  assert.deepEqual(result.message.key, originalKey);

  const wrongAuthor = serviceFor([storedRow({ key: { ...originalKey, participant: 'other-author@lid' } })]);
  assert.equal(
    (await wrongAuthor.service.getMessageForDeletion(notificationKey, revokeTargetKey)).result,
    'missing',
  );
  const wrongTargetAuthor = serviceFor([storedRow({ key: originalKey })]);
  assert.equal(
    (await wrongTargetAuthor.service.getMessageForDeletion(notificationKey, {
      ...revokeTargetKey,
      participant: 'other-author@lid',
    })).result,
    'missing',
  );
});

test('Delete for Everyone rejects missing IDs, wrong chats, ambiguous originals and foreign instances', async () => {
  const invalidId = serviceFor([storedRow()]);
  assert.equal(
    (await invalidId.service.getMessageForDeletion(targetKey, { ...targetKey, id: 'other-id' })).result,
    'invalid_identity',
  );

  const wrongChat = serviceFor([storedRow({ key: { remoteJid: 'other-user@lid' } })]);
  assert.equal((await wrongChat.service.getMessageForDeletion(targetKey, targetKey)).result, 'missing');

  const duplicate = serviceFor([storedRow(), storedRow()]);
  assert.equal((await duplicate.service.getMessageForDeletion(targetKey, targetKey)).result, 'ambiguous');

  const foreignInstance = serviceFor([storedRow()]);
  foreignInstance.service.instanceId = 'other-instance';
  assert.equal((await foreignInstance.service.getMessageForDeletion(targetKey, targetKey)).result, 'missing');
});

test('only an explicit Baileys REVOKE stub is forwarded as Delete for Everyone', async () => {
  const originalRow = { ...storedRow(), messageTimestamp: 1_793_000_000 };
  const otherChatRow = {
    ...storedRow({
      key: {
        remoteJid: 'synthetic-other@lid',
        participant: 'synthetic-other@lid',
        remoteJidAlt: 'synthetic-other@s.whatsapp.net',
        participantAlt: 'synthetic-other@s.whatsapp.net',
      },
    }),
    id: 'synthetic-row-id-2',
    messageTimestamp: 1_793_000_001,
  };
  const eventCalls: unknown[][] = [];
  const updateRows: any[] = [];
  const cacheValues = new Map<string, unknown>();
  let failNextPersistence = true;
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
    $queryRaw: async () => [originalRow, otherChatRow],
    messageUpdate: {
      create: async (input: any) => {
        if (failNextPersistence) {
          failNextPersistence = false;
          throw new Error('synthetic persistence failure');
        }
        updateRows.push(input.data);
      },
    },
    message: { update: async () => undefined },
    chat: { findFirst: async () => undefined },
  };
  const cache = {
    get: async (key: string) => cacheValues.get(key),
    set: async (key: string, value: unknown) => cacheValues.set(key, value),
  };
  const previousConnection = postgresClient.getChatwootConnection;
  postgresClient.getChatwootConnection = (() => ({})) as any;

  let service: any;
  try {
    service = new (BaileysStartupService as any)(config, {}, repository, {}, {}, cache, {});
  } finally {
    postgresClient.getChatwootConnection = previousConnection;
  }
  service.instance = { name: 'synthetic-instance', id: 'synthetic-instance' };
  const deleteStages: string[] = [];
  service.logger = {
    verbose: () => {},
    info: (record: any) => {
      if (record?.diagnostic === 'whatsapp_delete') deleteStages.push(`${record.stage}:${record.result || record.reason || ''}`);
    },
    warn: () => {},
    error: () => {},
    log: () => {},
  };
  service.sendDataWebhook = async (...args: unknown[]) => eventCalls.push(args);

  const revoke = {
    key: { ...targetKey },
    revokeTargetKey: { ...targetKey },
    update: { message: null, messageStubType: proto.WebMessageInfo.StubType.REVOKE },
  };
  await assert.rejects(service.messageHandle['messages.update']([revoke], {}), /synthetic persistence failure/);
  assert.equal(eventCalls.length, 1);
  assert.equal(cacheValues.size, 0);

  await service.messageHandle['messages.update']([revoke], {});
  await service.messageHandle['messages.update']([revoke], {});

  assert.equal(eventCalls.length, 2, `deletion dispatch stages: ${deleteStages.join(',')}`);
  assert.equal(eventCalls[0][0], Events.MESSAGES_DELETE);
  assert.deepEqual(eventCalls[0][1], {
    id: storedKey.id,
    remoteJid: storedKey.remoteJid,
    fromMe: storedKey.fromMe,
    participant: storedKey.participant,
    status: 'DELETED',
  });
  assert.equal(updateRows.length, 1);
  assert.equal(updateRows[0].status, 'DELETED');
  assert.equal(updateRows[0].messageId, 'synthetic-row-id');
  assert.equal(updateRows[0].keyId, storedKey.id);
  assert.equal('message' in updateRows[0], false);
  assert.equal('messageTimestamp' in updateRows[0], false);
  assert.equal(cacheValues.size, 1);
  assert.equal(originalRow.messageTimestamp, 1_793_000_000);

  const otherChatNotification = {
    id: targetKey.id,
    remoteJid: 'synthetic-other@lid',
    fromMe: false,
    participant: 'synthetic-other@lid',
  };
  await service.messageHandle['messages.update']([{
    key: otherChatNotification,
    revokeTargetKey: { id: targetKey.id, remoteJid: 'synthetic-self@lid', fromMe: true },
    update: { message: null, messageStubType: proto.WebMessageInfo.StubType.REVOKE },
  }], {});
  assert.equal(eventCalls.filter((call) => call[0] === Events.MESSAGES_DELETE).length, 3);
  assert.equal(updateRows.length, 2);
  assert.equal(updateRows[1].messageId, 'synthetic-row-id-2');
  assert.equal((eventCalls[2][1] as any).remoteJid, 'synthetic-other@lid');

  await service.messageHandle['messages.update'](
    [{ key: { ...targetKey }, update: { message: null } }],
    {},
  );
  assert.equal(eventCalls.filter((call) => call[0] === Events.MESSAGES_DELETE).length, 3);
});

test('non-edit protocol upserts are not treated as edits before the deletion update', async () => {
  const originalRow = { ...storedRow(), messageTimestamp: 1_793_000_000 };
  const eventCalls: unknown[][] = [];
  const updateRows: any[] = [];
  const databaseUpdates: any[] = [];
  const chatLookups: any[] = [];
  const cacheValues = new Map<string, unknown>();
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
    message: {
      update: async (input: any) => {
        databaseUpdates.push(input);
        Object.assign(originalRow, input.data);
      },
    },
    chat: { findFirst: async (input: any) => chatLookups.push(input) },
  };
  const cache = {
    get: async (key: string) => cacheValues.get(key),
    set: async (key: string, value: unknown) => cacheValues.set(key, value),
  };
  const previousConnection = postgresClient.getChatwootConnection;
  postgresClient.getChatwootConnection = (() => ({})) as any;

  let service: any;
  try {
    service = new (BaileysStartupService as any)(config, {}, repository, {}, {}, cache, {});
  } finally {
    postgresClient.getChatwootConnection = previousConnection;
  }
  service.instance = { name: 'synthetic-instance', id: 'synthetic-instance' };
  service.logger = { verbose: () => {}, info: () => {}, warn: () => {}, error: () => {}, log: () => {} };
  service.getMessage = async () => originalRow;
  service.sendDataWebhook = async (...args: unknown[]) => eventCalls.push(args);

  const revokeTargetKey = { id: targetKey.id, remoteJid: 'synthetic-self@lid', fromMe: true };
  const notification = {
    key: { ...targetKey, id: 'SYNTHETIC_REVOKE_NOTIFICATION_ID' },
    message: { protocolMessage: { type: proto.Message.ProtocolMessage.Type.REVOKE, key: revokeTargetKey } },
    messageTimestamp: 1_793_300_000,
  };
  const revokeUpdate = {
    key: { ...targetKey },
    revokeTargetKey,
    update: { message: null, messageStubType: proto.WebMessageInfo.StubType.REVOKE },
  };

  await service.messageHandle['messages.upsert']({ messages: [notification], type: 'notify' }, {});
  await service.messageHandle['messages.upsert']({ messages: [notification], type: 'notify' }, {});
  await service.messageHandle['messages.upsert'](
    {
      type: 'notify',
      messages: [
        {
          key: { ...targetKey, id: 'SYNTHETIC_EPHEMERAL_NOTIFICATION_ID' },
          message: {
            protocolMessage: {
              type: proto.Message.ProtocolMessage.Type.EPHEMERAL_SETTING,
              ephemeralExpiration: 60,
            },
          },
          messageTimestamp: 1_793_300_000,
        },
      ],
    },
    {},
  );
  await service.messageHandle['messages.update']([revokeUpdate], {});
  await service.messageHandle['messages.update']([revokeUpdate], {});

  assert.deepEqual(eventCalls.map((call) => call[0]), [Events.MESSAGES_DELETE]);
  assert.equal(databaseUpdates.length, 0);
  assert.equal(updateRows.length, 1);
  assert.equal(updateRows[0].status, 'DELETED');
  assert.equal(originalRow.messageTimestamp, 1_793_000_000);
  assert.equal(originalRow.status, undefined);
  assert.equal(chatLookups.length, 0);
});

test('legacy upsert edit handling still accepts only a genuine MESSAGE_EDIT', async () => {
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
    message: {
      update: async (input: any) => {
        databaseUpdates.push(input);
        Object.assign(originalRow, input.data);
      },
    },
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
  service.instance = { name: 'synthetic-instance', id: 'synthetic-instance' };
  service.logger = { verbose: () => {}, info: () => {}, warn: () => {}, error: () => {}, log: () => {} };
  service.getMessage = async () => originalRow;
  service.sendDataWebhook = async (...args: unknown[]) => eventCalls.push(args);

  await service.messageHandle['messages.upsert'](
    {
      type: 'notify',
      messages: [
        {
          key: { ...targetKey, id: 'SYNTHETIC_EDIT_NOTIFICATION_ID' },
          message: {
            protocolMessage: {
              type: proto.Message.ProtocolMessage.Type.MESSAGE_EDIT,
              key: { ...targetKey },
              editedMessage: { conversation: 'synthetic edited body' },
            },
          },
          messageTimestamp: 1_793_300_000,
        },
      ],
    },
    {},
  );

  assert.equal(eventCalls.length, 1);
  assert.equal(eventCalls[0][0], Events.MESSAGES_EDITED);
  assert.equal(databaseUpdates.length, 1);
  assert.equal(databaseUpdates[0].data.status, 'EDITED');
  assert.equal(databaseUpdates[0].data.messageTimestamp, 1_793_300_000);
  assert.equal(updateRows.length, 1);
  assert.equal(updateRows[0].status, 'EDITED');
});
