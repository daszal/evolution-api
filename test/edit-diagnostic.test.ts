import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WebhookController } from '../src/api/integrations/event/webhook/webhook.controller';

function controllerFor(logs: unknown[]) {
  const controller: any = Object.create(WebhookController.prototype);
  controller.logger = {
    info: (record: unknown) => logs.push(record),
    error: (record: unknown) => logs.push(record),
    log: (record: unknown) => logs.push(record),
  };
  return controller;
}

const editEvent = {
  event: 'messages.update',
  data: { status: 'EDITED', messageId: 'PRIVATE_MESSAGE_ID', message: { conversation: 'PRIVATE_BODY' } },
  destination: 'https://private-webhook.invalid/messages-update',
  apikey: 'PRIVATE_API_KEY',
};

test('edit webhook success logs only bounded metadata', async () => {
  const logs: unknown[] = [];
  const controller = controllerFor(logs);
  await controller.retryWebhookRequest(
    { post: async () => ({ status: 204 }) },
    editEvent,
    'private-origin',
    'https://private-webhook.invalid/messages-update',
    'https://private-server.invalid',
    1,
    0,
  );

  assert.deepEqual(logs, [
    {
      diagnostic: 'whatsapp_edit',
      stage: 'webhook_response',
      target: 'local',
      outcome: 'success',
      retried: false,
    },
  ]);
  const serialized = JSON.stringify(logs);
  for (const privateValue of ['PRIVATE_MESSAGE_ID', 'PRIVATE_BODY', 'PRIVATE_API_KEY', 'private-webhook.invalid', 'private-server.invalid']) {
    assert.equal(serialized.includes(privateValue), false);
  }
});

test('edit webhook 422 logs a fixed outcome without error details', async () => {
  const logs: unknown[] = [];
  const controller = controllerFor(logs);
  const error = Object.assign(new Error('PRIVATE_BODY'), {
    response: { status: 422 },
    config: { url: 'https://private-webhook.invalid/messages-update' },
  });

  await assert.rejects(
    controller.retryWebhookRequest(
      { post: async () => Promise.reject(error) },
      editEvent,
      'private-origin',
      'https://private-webhook.invalid/messages-update',
      'https://private-server.invalid',
      1,
      0,
    ),
  );

  assert.deepEqual(logs, [
    {
      diagnostic: 'whatsapp_edit',
      stage: 'webhook_response',
      target: 'local',
      outcome: 'unprocessable',
      retried: false,
    },
  ]);
  assert.equal(JSON.stringify(logs).includes('PRIVATE_BODY'), false);
  assert.equal(JSON.stringify(logs).includes('private-webhook.invalid'), false);
});
