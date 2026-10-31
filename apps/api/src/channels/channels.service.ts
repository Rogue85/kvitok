import { t } from '@kvitok/i18n';
import { Injectable } from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type {
  ChannelDto,
  ChannelSecretsDto,
  CreateChannelInput,
  UpdateChannelInput,
} from '@kvitok/shared';
import { errors } from '../common/errors';
import { newId } from '../common/ids';
import { json } from '../common/json';
import { SecretBox } from '../crypto/secret-box';
import type { Channel } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  apiConfig,
  emailConfig,
  isSandboxMailbox,
  type ApiChannelConfig,
  type ApiChannelSecrets,
  type EmailChannelConfig,
  type EmailChannelSecrets,
  type ResolvedMailbox,
} from './channel-config';

const API_KEY_PREFIX = 'ask_';

@Injectable()
export class ChannelsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly box: SecretBox,
  ) {}

  async list(workspaceId: string): Promise<ChannelDto[]> {
    const [channels, workspace] = await Promise.all([
      this.prisma.channel.findMany({ where: { workspaceId }, orderBy: { createdAt: 'asc' } }),
      this.prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } }),
    ]);
    return channels.map((c) => this.toDto(c, workspace.defaultMailboxId));
  }

  async get(workspaceId: string, id: string): Promise<Channel> {
    const channel = await this.prisma.channel.findFirst({ where: { id, workspaceId } });
    if (channel === null) {
      throw errors.notFound(t('api.channelNotFound'));
    }
    return channel;
  }

  async getDto(workspaceId: string, id: string): Promise<ChannelDto> {
    const [channel, workspace] = await Promise.all([
      this.get(workspaceId, id),
      this.prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } }),
    ]);
    return this.toDto(channel, workspace.defaultMailboxId);
  }

  async create(workspaceId: string, input: CreateChannelInput): Promise<ChannelSecretsDto> {
    if (input.type === 'api') {
      const apiKey = generateApiKey();
      const webhookSecret = input.webhookUrl ? generateWebhookSecret() : undefined;
      const config: ApiChannelConfig = { metadataMapping: input.metadataMapping ?? {}, webhookUrl: input.webhookUrl ?? null };
      const secrets: ApiChannelSecrets = webhookSecret ? { webhookSecret } : {};
      const channel = await this.prisma.channel.create({
        data: {
          id: newId(),
          workspaceId,
          type: 'api',
          name: input.name,
          config: json(config),
          secrets: this.box.encrypt(secrets),
          apiKeyHash: hashApiKey(apiKey),
          apiKeyPrefix: apiKey.slice(0, API_KEY_PREFIX.length + 6),
        },
      });
      return { channel: this.toDto(channel, null), apiKey, ...(webhookSecret ? { webhookSecret } : {}) };
    }

    const transport = input.transport ?? 'smtp';
    if (transport === 'smtp' && !input.smtp?.password) {
      throw errors.validation([{ path: 'smtp.password', message: t('api.smtpPasswordRequired'), code: 'custom' }]);
    }
    if (input.imap && !input.imap.password) {
      throw errors.validation([{ path: 'imap.password', message: t('api.imapPasswordRequired'), code: 'custom' }]);
    }

    const config: EmailChannelConfig = {
      transport,
      address: input.address,
      displayName: input.displayName ?? '',
      signatureHtml: input.signatureHtml ?? '',
      smtp: input.smtp ? { host: input.smtp.host, port: input.smtp.port, secure: input.smtp.secure ?? true, user: input.smtp.user } : null,
      imap: input.imap
        ? {
            host: input.imap.host,
            port: input.imap.port,
            secure: input.imap.secure ?? true,
            user: input.imap.user,
            folder: input.imap.folder ?? 'INBOX',
            importExisting: input.imap.importExisting ?? false,
          }
        : null,
    };
    const secrets: EmailChannelSecrets = {
      ...(input.smtp?.password ? { smtpPassword: input.smtp.password } : {}),
      ...(input.imap?.password ? { imapPassword: input.imap.password } : {}),
    };

    const channel = await this.prisma.$transaction(async (tx) => {
      const created = await tx.channel.create({
        data: {
          id: newId(),
          workspaceId,
          type: 'email',
          name: input.name,
          config: json(config),
          secrets: this.box.encrypt(secrets),
        },
      });
      // The first mailbox becomes the default mailbox for replies.
      await tx.workspace.updateMany({ where: { id: workspaceId, defaultMailboxId: null }, data: { defaultMailboxId: created.id } });
      return created;
    });
    const workspace = await this.prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
    return { channel: this.toDto(channel, workspace.defaultMailboxId) };
  }

  async update(workspaceId: string, id: string, input: UpdateChannelInput): Promise<ChannelSecretsDto> {
    const channel = await this.get(workspaceId, id);
    let webhookSecret: string | undefined;
    let config: object;
    let secrets: object;

    if (channel.type === 'api') {
      const current = apiConfig(channel);
      const currentSecrets = this.secretsOf<ApiChannelSecrets>(channel);
      const next: ApiChannelConfig = {
        metadataMapping: input.metadataMapping ?? current.metadataMapping,
        webhookUrl: input.webhookUrl === undefined ? current.webhookUrl : input.webhookUrl,
      };
      if (next.webhookUrl && !currentSecrets.webhookSecret) {
        webhookSecret = generateWebhookSecret();
      }
      config = next;
      secrets = webhookSecret ? { ...currentSecrets, webhookSecret } : currentSecrets;
    } else {
      const current = emailConfig(channel);
      const currentSecrets = this.secretsOf<EmailChannelSecrets>(channel);
      if (isSandboxMailbox(current) && (input.smtp || input.imap)) {
        throw errors.validation([{ path: 'transport', message: t('validation.sandboxHasNoServers'), code: 'custom' }]);
      }
      const smtp = input.smtp
        ? { host: input.smtp.host, port: input.smtp.port, secure: input.smtp.secure ?? true, user: input.smtp.user }
        : current.smtp;
      const imap =
        input.imap === undefined
          ? current.imap
          : input.imap === null
            ? null
            : {
                host: input.imap.host,
                port: input.imap.port,
                secure: input.imap.secure ?? true,
                user: input.imap.user,
                folder: input.imap.folder ?? 'INBOX',
                importExisting: input.imap.importExisting ?? false,
              };
      const nextSecrets: EmailChannelSecrets = {
        smtpPassword: input.smtp?.password ?? currentSecrets.smtpPassword,
        imapPassword: imap === null ? undefined : (input.imap?.password ?? currentSecrets.imapPassword),
      };
      if (imap !== null && !nextSecrets.imapPassword) {
        throw errors.validation([{ path: 'imap.password', message: t('api.imapPasswordRequired'), code: 'custom' }]);
      }
      config = {
        ...current,
        displayName: input.displayName ?? current.displayName,
        signatureHtml: input.signatureHtml ?? current.signatureHtml,
        smtp,
        imap,
      } satisfies EmailChannelConfig;
      secrets = nextSecrets;
    }

    const updated = await this.prisma.channel.update({
      where: { id },
      data: {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        config: json(config),
        secrets: this.box.encrypt(secrets),
      },
    });
    const workspace = await this.prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
    return { channel: this.toDto(updated, workspace.defaultMailboxId), ...(webhookSecret ? { webhookSecret } : {}) };
  }

  async rotateApiKey(workspaceId: string, id: string): Promise<ChannelSecretsDto> {
    const channel = await this.get(workspaceId, id);
    if (channel.type !== 'api') {
      throw errors.validation([{ path: 'type', message: t('api.keyOnlyForApiChannel'), code: 'custom' }]);
    }
    const apiKey = generateApiKey();
    const updated = await this.prisma.channel.update({
      where: { id },
      data: { apiKeyHash: hashApiKey(apiKey), apiKeyPrefix: apiKey.slice(0, API_KEY_PREFIX.length + 6) },
    });
    return { channel: this.toDto(updated, null), apiKey };
  }

  async rotateWebhookSecret(workspaceId: string, id: string): Promise<ChannelSecretsDto> {
    const channel = await this.get(workspaceId, id);
    if (channel.type !== 'api') {
      throw errors.validation([{ path: 'type', message: t('api.webhookOnlyForApiChannel'), code: 'custom' }]);
    }
    const webhookSecret = generateWebhookSecret();
    const updated = await this.prisma.channel.update({
      where: { id },
      data: { secrets: this.box.encrypt({ ...this.secretsOf<ApiChannelSecrets>(channel), webhookSecret }) },
    });
    return { channel: this.toDto(updated, null), webhookSecret };
  }

  async setDefaultMailbox(workspaceId: string, id: string): Promise<ChannelDto> {
    const channel = await this.get(workspaceId, id);
    if (channel.type !== 'email') {
      throw errors.validation([{ path: 'type', message: t('api.onlyMailboxCanBeDefault'), code: 'custom' }]);
    }
    await this.prisma.workspace.update({ where: { id: workspaceId }, data: { defaultMailboxId: id } });
    return this.toDto(channel, id);
  }

  /** A channel by id and the key from the Authorization header (ingest). */
  async authenticateApiKey(channelId: string, apiKey: string): Promise<Channel | null> {
    const channel = await this.prisma.channel.findUnique({ where: { id: channelId } });
    if (channel === null || channel.type !== 'api' || channel.apiKeyHash === null) {
      return null;
    }
    const expected = Buffer.from(channel.apiKeyHash, 'hex');
    const actual = Buffer.from(hashApiKey(apiKey), 'hex');
    return expected.length === actual.length && timingSafeEqual(expected, actual) ? channel : null;
  }

  resolveMailbox(channel: Channel): ResolvedMailbox {
    if (channel.type !== 'email') {
      throw new Error(`Channel ${channel.id} is not a mailbox`);
    }
    return { channel, config: emailConfig(channel), secrets: this.secretsOf<EmailChannelSecrets>(channel) };
  }

  webhookSecret(channel: Channel): string | null {
    return this.secretsOf<ApiChannelSecrets>(channel).webhookSecret ?? null;
  }

  private secretsOf<T>(channel: Channel): T {
    return (channel.secrets ? this.box.decrypt<T>(channel.secrets) : {}) as T;
  }

  private toDto(channel: Channel, defaultMailboxId: string | null): ChannelDto {
    const base = {
      id: channel.id,
      type: channel.type,
      name: channel.name,
      enabled: channel.enabled,
      createdAt: channel.createdAt.toISOString(),
    };

    if (channel.type === 'api') {
      const config = apiConfig(channel);
      return {
        ...base,
        apiKeyPrefix: channel.apiKeyPrefix,
        metadataMapping: config.metadataMapping,
        webhookUrl: config.webhookUrl,
        hasWebhookSecret: Boolean(this.secretsOf<ApiChannelSecrets>(channel).webhookSecret),
      };
    }

    const config = emailConfig(channel);
    const secrets = this.secretsOf<EmailChannelSecrets>(channel);
    return {
      ...base,
      address: config.address,
      displayName: config.displayName,
      signatureHtml: config.signatureHtml,
      transport: config.transport ?? 'smtp',
      smtp: config.smtp ? { ...config.smtp, hasPassword: Boolean(secrets.smtpPassword) } : null,
      imap: config.imap ? { ...config.imap, hasPassword: Boolean(secrets.imapPassword) } : null,
      lastSyncAt: channel.lastSyncAt?.toISOString() ?? null,
      lastSyncError: channel.lastSyncError,
      isDefaultMailbox: defaultMailboxId === channel.id,
    };
  }
}

function generateApiKey(): string {
  return `${API_KEY_PREFIX}${randomBytes(24).toString('base64url')}`;
}

function generateWebhookSecret(): string {
  return `whsec_${randomBytes(24).toString('base64url')}`;
}

export function hashApiKey(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex');
}
