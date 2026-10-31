import type { MailTransport } from '@kvitok/shared';
import type { Channel } from '../generated/prisma/client';

export interface ApiChannelConfig {
  metadataMapping: Record<string, string>;
  webhookUrl: string | null;
}

export interface ApiChannelSecrets {
  webhookSecret?: string;
}

export interface SmtpSettings {
  host: string;
  port: number;
  secure: boolean;
  user: string;
}

export interface ImapSettings extends SmtpSettings {
  folder: string;
  importExisting: boolean;
}

export interface EmailChannelConfig {
  /** Absent in mailboxes created before the test transport — those are smtp. */
  transport?: MailTransport;
  address: string;
  displayName: string;
  signatureHtml: string;
  /** null for a test mailbox. */
  smtp: SmtpSettings | null;
  imap: ImapSettings | null;
}

export interface EmailChannelSecrets {
  smtpPassword?: string;
  imapPassword?: string;
}

export interface ImapSyncState {
  uidValidity?: string;
  lastUid?: number;
}

/** Mailbox config together with decrypted passwords — for sending and receiving only. */
export interface ResolvedMailbox {
  channel: Channel;
  config: EmailChannelConfig;
  secrets: EmailChannelSecrets;
}

export function apiConfig(channel: Channel): ApiChannelConfig {
  const config = channel.config as Partial<ApiChannelConfig>;
  return { metadataMapping: config.metadataMapping ?? {}, webhookUrl: config.webhookUrl ?? null };
}

export function emailConfig(channel: Channel): EmailChannelConfig {
  return channel.config as unknown as EmailChannelConfig;
}

export function isSandboxMailbox(config: EmailChannelConfig): boolean {
  return config.transport === 'sandbox';
}

export function mailboxDomain(address: string): string {
  return address.split('@')[1] ?? 'localhost';
}
