import { t } from '@kvitok/i18n';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type IORedis from 'ioredis';
import { ChannelsService } from '../channels/channels.service';
import type { ImapSyncState } from '../channels/channel-config';
import { json } from '../common/json';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS } from '../redis/redis.module';
import { MailIngestService } from './mail-ingest.service';
import { MAILBOX_SOURCE_FACTORY, type MailboxSourceFactory } from './mailbox-source';

/** After this many failed attempts an email is skipped so it does not block the mailbox. */
const MAX_MESSAGE_FAILURES = 3;
const LOCK_TTL_MS = 5 * 60 * 1000;

interface PollState extends ImapSyncState {
  failedUid?: number;
  failures?: number;
}

export interface PollResult {
  imported: number;
  skipped: number;
  error: string | null;
}

@Injectable()
export class ImapPoller {
  private readonly logger = new Logger(ImapPoller.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly channels: ChannelsService,
    private readonly ingest: MailIngestService,
    @Inject(MAILBOX_SOURCE_FACTORY) private readonly sourceFactory: MailboxSourceFactory,
    @Inject(REDIS) private readonly redis: IORedis,
  ) {}

  async poll(channelId: string): Promise<PollResult | null> {
    const channel = await this.prisma.channel.findUnique({ where: { id: channelId } });
    if (channel === null || channel.type !== 'email' || !channel.enabled) {
      return null;
    }
    const mailbox = this.channels.resolveMailbox(channel);
    if (mailbox.config.imap === null) {
      return null;
    }

    // One poll of a mailbox at a time, even if jobs overlap.
    const lockKey = `lock:imap:${channelId}`;
    if ((await this.redis.set(lockKey, '1', 'PX', LOCK_TTL_MS, 'NX')) === null) {
      return null;
    }

    const result: PollResult = { imported: 0, skipped: 0, error: null };
    let state = channel.syncState as PollState;
    const save = async (patch: Partial<{ lastSyncError: string | null }> = {}) => {
      await this.prisma.channel.update({
        where: { id: channelId },
        data: { syncState: json(state), lastSyncAt: new Date(), ...patch },
      });
    };

    // A skipped email stays visible in lastSyncError until the poll ends.
    let skipNotice: string | null = null;
    const source = this.sourceFactory(mailbox);
    try {
      const box = await source.open(mailbox.config.imap.folder);
      if (state.uidValidity !== box.uidValidity) {
        // A new mailbox or UIDVALIDITY changed: the old UIDs are invalid.
        // History is imported only when explicitly configured, otherwise start with new emails.
        state = { uidValidity: box.uidValidity, lastUid: mailbox.config.imap.importExisting ? 0 : Math.max(0, box.uidNext - 1) };
        await save();
      }

      for await (const message of source.fetchSince(state.lastUid ?? 0)) {
        try {
          const outcome = await this.ingest.ingest(channel, message.source);
          if (outcome.status === 'created' || outcome.status === 'appended') {
            result.imported += 1;
          }
          state = { uidValidity: state.uidValidity, lastUid: message.uid };
          await save({ lastSyncError: skipNotice });
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error);
          const failures = state.failedUid === message.uid ? (state.failures ?? 0) + 1 : 1;
          if (failures >= MAX_MESSAGE_FAILURES) {
            this.logger.error(`Skipping UID ${message.uid} in channel ${channelId} after ${failures} failures: ${text}`);
            state = { uidValidity: state.uidValidity, lastUid: message.uid };
            result.skipped += 1;
            skipNotice = t('api.imapMessageSkipped', { uid: message.uid, error: text }).slice(0, 1000);
            await save({ lastSyncError: skipNotice });
            continue;
          }
          state = { ...state, failedUid: message.uid, failures };
          result.error = text;
          await save({ lastSyncError: text.slice(0, 1000) });
          break;
        }
      }
      if (result.error === null) {
        await save({ lastSyncError: skipNotice });
      }
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
      this.logger.warn(`IMAP poll failed for channel ${channelId}: ${result.error}`);
      await save({ lastSyncError: result.error.slice(0, 1000) });
    } finally {
      await source.close().catch(() => undefined);
      await this.redis.del(lockKey);
    }
    return result;
  }
}
