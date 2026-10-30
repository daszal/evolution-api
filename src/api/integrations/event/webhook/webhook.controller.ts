import { EventDto } from '@api/integrations/event/event.dto';
import { PrismaRepository } from '@api/repository/repository.service';
import { WAMonitoringService } from '@api/services/monitor.service';
import { Events, wa } from '@api/types/wa.types';
import { configService, Log, Webhook } from '@config/env.config';
import { Logger } from '@config/logger.config';
// import { BadRequestException } from '@exceptions';
import axios, { AxiosInstance } from 'axios';
import * as jwt from 'jsonwebtoken';

import { EmitData, EventController, EventControllerInterface } from '../event.controller';

const editHttpOutcome = (status?: number) => {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 422) return 'unprocessable';
  if (status && status >= 200 && status < 300) return 'success';
  if (status && status >= 400 && status < 500) return 'client_error';
  if (status && status >= 500) return 'server_error';
  return 'network_error';
};

export class WebhookController extends EventController implements EventControllerInterface {
  private readonly logger = new Logger('WebhookController');

  constructor(prismaRepository: PrismaRepository, waMonitor: WAMonitoringService) {
    super(prismaRepository, waMonitor, true, 'webhook');
  }

  override async set(instanceName: string, data: EventDto): Promise<wa.LocalWebHook> {
    // if (!/^(https?:\/\/)/.test(data.webhook.url)) {
    //   throw new BadRequestException('Invalid "url" property');
    // }

    if (!data.webhook?.enabled) {
      data.webhook.events = [];
    } else {
      if (0 === data.webhook.events.length) {
        data.webhook.events = EventController.events;
      }
    }

    return this.prisma.webhook.upsert({
      where: {
        instanceId: this.monitor.waInstances[instanceName].instanceId,
      },
      update: {
        enabled: data.webhook?.enabled,
        events: data.webhook?.events,
        url: data.webhook?.url,
        headers: data.webhook?.headers,
        webhookBase64: data.webhook.base64,
        webhookByEvents: data.webhook.byEvents,
      },
      create: {
        enabled: data.webhook?.enabled,
        events: data.webhook?.events,
        instanceId: this.monitor.waInstances[instanceName].instanceId,
        url: data.webhook?.url,
        headers: data.webhook?.headers,
        webhookBase64: data.webhook.base64,
        webhookByEvents: data.webhook.byEvents,
      },
    });
  }

  public async emit({
    instanceName,
    origin,
    event,
    data,
    serverUrl,
    dateTime,
    sender,
    apiKey,
    local,
    integration,
    extra,
  }: EmitData): Promise<void> {
    const isMessageUpdate = event === Events.MESSAGES_UPDATE && (data as any)?.status === 'EDITED';
    if (integration && !integration.includes('webhook')) {
      return;
    }

    const instance = (await this.get(instanceName)) as wa.LocalWebHook;

    const webhookConfig = configService.get<Webhook>('WEBHOOK');
    const webhookLocal = instance?.events;
    const webhookHeaders = { ...((instance?.headers as Record<string, string>) || {}) };

    if (webhookHeaders && 'jwt_key' in webhookHeaders) {
      const jwtKey = webhookHeaders['jwt_key'];
      const jwtToken = this.generateJwtToken(jwtKey);
      webhookHeaders['Authorization'] = `Bearer ${jwtToken}`;

      delete webhookHeaders['jwt_key'];
    }

    const we = event.replace(/[.-]/gm, '_').toUpperCase();
    const transformedWe = we.replace(/_/gm, '-').toLowerCase();
    const enabledLog = configService.get<Log>('LOG').LEVEL.includes('WEBHOOKS');
    const regex = /^(https?:\/\/)/;

    const webhookData = {
      ...(extra ?? {}),
      event,
      instance: instanceName,
      data,
      destination: instance?.url || `${webhookConfig.GLOBAL.URL}/${transformedWe}`,
      date_time: dateTime,
      sender,
      server_url: serverUrl,
      apikey: apiKey,
    };

    if (isMessageUpdate) {
      this.logger.info({
        diagnostic: 'whatsapp_edit',
        stage: 'webhook_configuration',
        local_enabled: Boolean(instance?.enabled),
        local_subscribed: Array.isArray(webhookLocal) && webhookLocal.includes(we),
        local_destination_configured: Boolean(instance?.url),
        local_by_event_route: Boolean(instance?.webhookByEvents),
        global_enabled: Boolean(webhookConfig.GLOBAL?.ENABLED),
        global_subscribed: Boolean(webhookConfig.EVENTS[we]),
      });
    }

    if (local && instance?.enabled) {
      if (Array.isArray(webhookLocal) && webhookLocal.includes(we)) {
        let baseURL: string;

        if (instance?.webhookByEvents) {
          baseURL = `${instance?.url}/${transformedWe}`;
        } else {
          baseURL = instance?.url;
        }

        if (enabledLog && isMessageUpdate) {
          this.logger.log({
            diagnostic: 'whatsapp_edit',
            stage: 'webhook_dispatch',
            target: 'local',
            selected: true,
            by_event_route: Boolean(instance?.webhookByEvents),
          });
        } else if (enabledLog) {
          const logData = {
            local: `${origin}.sendData-Webhook`,
            url: baseURL,
            ...webhookData,
          };

          this.logger.log(logData);
        }

        try {
          if (instance?.enabled && regex.test(instance.url)) {
            const httpService = axios.create({
              baseURL,
              headers: webhookHeaders as Record<string, string> | undefined,
              timeout: webhookConfig.REQUEST?.TIMEOUT_MS ?? 30000,
            });

            await this.retryWebhookRequest(httpService, webhookData, `${origin}.sendData-Webhook`, baseURL, serverUrl);
          } else if (isMessageUpdate) {
            this.logger.warn({
              diagnostic: 'whatsapp_edit',
              stage: 'webhook_dispatch',
              target: 'local',
              outcome: 'invalid_target',
            });
          }
        } catch (error) {
          if (isMessageUpdate) {
            this.logger.error({
              diagnostic: 'whatsapp_edit',
              stage: 'webhook_dispatch',
              target: 'local',
              outcome: 'failed',
            });
          } else
            this.logger.error({
              local: `${origin}.sendData-Webhook`,
              message: `Todas as tentativas falharam: ${error?.message}`,
              hostName: error?.hostname,
              syscall: error?.syscall,
              code: error?.code,
              error: error?.errno,
              stack: error?.stack,
              name: error?.name,
              url: baseURL,
              server_url: serverUrl,
            });
        }
      }
    }

    if (webhookConfig.GLOBAL?.ENABLED) {
      if (webhookConfig.EVENTS[we]) {
        let globalURL = webhookConfig.GLOBAL.URL;

        if (webhookConfig.GLOBAL.WEBHOOK_BY_EVENTS) {
          globalURL = `${globalURL}/${transformedWe}`;
        }

        if (enabledLog && isMessageUpdate) {
          this.logger.log({
            diagnostic: 'whatsapp_edit',
            stage: 'webhook_dispatch',
            target: 'global',
            selected: true,
            by_event_route: Boolean(webhookConfig.GLOBAL.WEBHOOK_BY_EVENTS),
          });
        } else if (enabledLog) {
          const logData = {
            local: `${origin}.sendData-Webhook-Global`,
            url: globalURL,
            ...webhookData,
          };

          this.logger.log(logData);
        }

        try {
          if (regex.test(globalURL)) {
            const httpService = axios.create({
              baseURL: globalURL,
              timeout: webhookConfig.REQUEST?.TIMEOUT_MS ?? 30000,
            });

            await this.retryWebhookRequest(
              httpService,
              webhookData,
              `${origin}.sendData-Webhook-Global`,
              globalURL,
              serverUrl,
            );
          } else if (isMessageUpdate) {
            this.logger.warn({
              diagnostic: 'whatsapp_edit',
              stage: 'webhook_dispatch',
              target: 'global',
              outcome: 'invalid_target',
            });
          }
        } catch (error) {
          if (isMessageUpdate) {
            this.logger.error({
              diagnostic: 'whatsapp_edit',
              stage: 'webhook_dispatch',
              target: 'global',
              outcome: 'failed',
            });
          } else
            this.logger.error({
              local: `${origin}.sendData-Webhook-Global`,
              message: `Todas as tentativas falharam: ${error?.message}`,
              hostName: error?.hostname,
              syscall: error?.syscall,
              code: error?.code,
              error: error?.errno,
              stack: error?.stack,
              name: error?.name,
              url: globalURL,
              server_url: serverUrl,
            });
        }
      }
    }
  }

  private async retryWebhookRequest(
    httpService: AxiosInstance,
    webhookData: any,
    origin: string,
    baseURL: string,
    serverUrl: string,
    maxRetries?: number,
    delaySeconds?: number,
  ): Promise<void> {
    const webhookConfig = configService.get<Webhook>('WEBHOOK');
    const isMessageUpdate = webhookData?.event === Events.MESSAGES_UPDATE && webhookData?.data?.status === 'EDITED';
    const target = origin.includes('Global') ? 'global' : 'local';
    const maxRetryAttempts = maxRetries ?? webhookConfig.RETRY?.MAX_ATTEMPTS ?? 10;
    const initialDelay = delaySeconds ?? webhookConfig.RETRY?.INITIAL_DELAY_SECONDS ?? 5;
    const useExponentialBackoff = webhookConfig.RETRY?.USE_EXPONENTIAL_BACKOFF ?? true;
    const maxDelay = webhookConfig.RETRY?.MAX_DELAY_SECONDS ?? 300;
    const jitterFactor = webhookConfig.RETRY?.JITTER_FACTOR ?? 0.2;
    const nonRetryableStatusCodes = webhookConfig.RETRY?.NON_RETRYABLE_STATUS_CODES ?? [400, 401, 403, 404, 422];

    let attempts = 0;

    while (attempts < maxRetryAttempts) {
      try {
        const response = await httpService.post('', webhookData);
        if (isMessageUpdate) {
          this.logger.info({
            diagnostic: 'whatsapp_edit',
            stage: 'webhook_response',
            target,
            outcome: editHttpOutcome(response?.status),
            retried: attempts > 0,
          });
        }
        if (attempts > 0) {
          if (isMessageUpdate) {
            this.logger.info({ diagnostic: 'whatsapp_edit', stage: 'webhook_retry', target, outcome: 'recovered' });
          } else
            this.logger.log({
              local: `${origin}`,
              message: `Sucesso no envio após ${attempts + 1} tentativas`,
              url: baseURL,
            });
        }
        return;
      } catch (error) {
        attempts++;

        const isTimeout = error.code === 'ECONNABORTED';

        if (error?.response?.status && nonRetryableStatusCodes.includes(error.response.status)) {
          if (isMessageUpdate) {
            this.logger.error({
              diagnostic: 'whatsapp_edit',
              stage: 'webhook_response',
              target,
              outcome: editHttpOutcome(error.response.status),
              retried: attempts > 1,
            });
          } else
            this.logger.error({
              local: `${origin}`,
              message: `Erro não recuperável (${error.response.status}): ${error?.message}. Cancelando retentativas.`,
              statusCode: error?.response?.status,
              url: baseURL,
              server_url: serverUrl,
            });
          throw error;
        }

        if (isMessageUpdate) {
          this.logger.error({
            diagnostic: 'whatsapp_edit',
            stage: 'webhook_response',
            target,
            outcome: editHttpOutcome(error?.response?.status),
            retried: attempts > 1,
          });
        } else
          this.logger.error({
            local: `${origin}`,
            message: `Tentativa ${attempts}/${maxRetryAttempts} falhou: ${isTimeout ? 'Timeout da requisição' : error?.message}`,
            hostName: error?.hostname,
            syscall: error?.syscall,
            code: error?.code,
            isTimeout,
            statusCode: error?.response?.status,
            error: error?.errno,
            stack: error?.stack,
            name: error?.name,
            url: baseURL,
            server_url: serverUrl,
          });

        if (attempts === maxRetryAttempts) {
          throw error;
        }

        let nextDelay = initialDelay;
        if (useExponentialBackoff) {
          nextDelay = Math.min(initialDelay * Math.pow(2, attempts - 1), maxDelay);

          const jitter = nextDelay * jitterFactor * (Math.random() * 2 - 1);
          nextDelay = Math.max(initialDelay, nextDelay + jitter);
        }

        if (isMessageUpdate) {
          this.logger.info({
            diagnostic: 'whatsapp_edit',
            stage: 'webhook_retry',
            target,
            outcome: 'waiting',
            retrying: true,
          });
        } else
          this.logger.log({
            local: `${origin}`,
            message: `Aguardando ${nextDelay.toFixed(1)} segundos antes da próxima tentativa`,
            url: baseURL,
          });

        await new Promise((resolve) => setTimeout(resolve, nextDelay * 1000));
      }
    }
  }

  private generateJwtToken(authToken: string): string {
    try {
      const payload = {
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 600, // 10 min expiration
        app: 'evolution',
        action: 'webhook',
      };

      const token = jwt.sign(payload, authToken, { algorithm: 'HS256' });
      return token;
    } catch (error) {
      this.logger.error({
        local: 'WebhookController.generateJwtToken',
        message: `JWT generation failed: ${error?.message}`,
      });
      throw error;
    }
  }
}
