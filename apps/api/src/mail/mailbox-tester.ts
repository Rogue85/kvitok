import { Inject, Injectable } from '@nestjs/common';
import type { ResolvedMailbox } from '../channels/channel-config';
import { EmailSender } from './email-sender';
import { MAILBOX_SOURCE_FACTORY, type MailboxSourceFactory } from './mailbox-source';

export interface CheckResult {
  ok: boolean;
  error?: string;
}

export interface MailboxTestResult {
  smtp: CheckResult;
  imap: CheckResult | null;
}

@Injectable()
export class MailboxTester {
  constructor(
    private readonly email: EmailSender,
    @Inject(MAILBOX_SOURCE_FACTORY) private readonly sourceFactory: MailboxSourceFactory,
  ) {}

  async test(mailbox: ResolvedMailbox): Promise<MailboxTestResult> {
    const smtp = await check(() => this.email.verify(mailbox));
    const imap =
      mailbox.config.imap === null
        ? null
        : await check(async () => {
            const source = this.sourceFactory(mailbox);
            try {
              await source.open(mailbox.config.imap!.folder);
            } finally {
              await source.close();
            }
          });
    return { smtp, imap };
  }
}

async function check(fn: () => Promise<unknown>): Promise<CheckResult> {
  try {
    await fn();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
