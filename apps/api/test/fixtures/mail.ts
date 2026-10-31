import { createTransport, type SendMailOptions } from 'nodemailer';

let counter = 0;

/** Builds a "raw" RFC 5322 email as IMAP would return it. */
export async function eml(options: SendMailOptions & { from?: string }): Promise<string> {
  counter += 1;
  const info = (await createTransport({ streamTransport: true, buffer: true }).sendMail({
    from: 'Иван Петров <ivan@client.example>',
    to: 'support@example.com',
    subject: 'Не печатает принтер',
    text: 'Добрый день! Принтер на 3 этаже не печатает.',
    messageId: `<msg-${counter}-${Date.now()}@client.example>`,
    ...options,
  })) as { message: Buffer };
  return info.message.toString('utf8');
}

/** A DSN about our email not being delivered (multipart/report). */
export function bounceEml(originalMessageId: string): string {
  return [
    'From: Mail Delivery System <mailer-daemon@mx.example.com>',
    'To: support@example.com',
    'Subject: Undelivered Mail Returned to Sender',
    `Message-ID: <bounce-${Date.now()}@mx.example.com>`,
    'MIME-Version: 1.0',
    'Content-Type: multipart/report; report-type=delivery-status; boundary="B"',
    '',
    '--B',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Your message could not be delivered.',
    '--B',
    'Content-Type: message/delivery-status',
    '',
    'Reporting-MTA: dns; mx.example.com',
    '',
    'Final-Recipient: rfc822; nobody@client.example',
    'Action: failed',
    'Status: 5.1.1',
    'Diagnostic-Code: smtp; 550 5.1.1 User unknown',
    '--B',
    'Content-Type: text/rfc822-headers',
    '',
    'From: support@example.com',
    'To: nobody@client.example',
    `Message-ID: ${originalMessageId}`,
    'Subject: Re: test',
    '--B--',
    '',
  ].join('\r\n');
}
