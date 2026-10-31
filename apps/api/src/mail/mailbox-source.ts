import { ImapFlow } from 'imapflow';
import type { ResolvedMailbox } from '../channels/channel-config';

/** The minimum of IMAP the poller needs; replaced in tests. */
export interface MailboxSource {
  open(folder: string): Promise<{ uidValidity: string; uidNext: number }>;
  fetchSince(lastUid: number): AsyncIterable<{ uid: number; source: Buffer }>;
  close(): Promise<void>;
}

export const MAILBOX_SOURCE_FACTORY = Symbol('MAILBOX_SOURCE_FACTORY');

export type MailboxSourceFactory = (mailbox: ResolvedMailbox) => MailboxSource;

export const imapSourceFactory: MailboxSourceFactory = (mailbox) => new ImapFlowSource(mailbox);

class ImapFlowSource implements MailboxSource {
  private readonly client: ImapFlow;
  private release: (() => void) | null = null;

  constructor(mailbox: ResolvedMailbox) {
    const imap = mailbox.config.imap;
    if (imap === null) {
      throw new Error('IMAP is not configured');
    }
    this.client = new ImapFlow({
      host: imap.host,
      port: imap.port,
      secure: imap.secure,
      auth: { user: imap.user, pass: mailbox.secrets.imapPassword ?? '' },
      logger: false,
      connectionTimeout: 15_000,
    });
  }

  async open(folder: string): Promise<{ uidValidity: string; uidNext: number }> {
    await this.client.connect();
    const lock = await this.client.getMailboxLock(folder);
    this.release = () => lock.release();
    const mailbox = this.client.mailbox;
    if (mailbox === false) {
      throw new Error(`Mailbox ${folder} is not selected`);
    }
    return { uidValidity: mailbox.uidValidity.toString(), uidNext: mailbox.uidNext };
  }

  async *fetchSince(lastUid: number): AsyncIterable<{ uid: number; source: Buffer }> {
    for await (const message of this.client.fetch(`${lastUid + 1}:*`, { uid: true, source: true }, { uid: true })) {
      if (message.uid > lastUid && message.source) {
        yield { uid: message.uid, source: message.source };
      }
    }
  }

  async close(): Promise<void> {
    this.release?.();
    this.release = null;
    await this.client.logout().catch(() => undefined);
  }
}
