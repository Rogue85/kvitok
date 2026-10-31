import { describe, expect, it } from 'vitest';
import { replySubject, threadHeaders, ticketNumberFromSubject } from './threading';

describe('replySubject', () => {
  it('adds Re: and the ticket token once', () => {
    expect(replySubject('Не начислили баллы', 12)).toBe('Re: Не начислили баллы [#T-12]');
    expect(replySubject('RE: Fwd: Не начислили баллы', 12)).toBe('Re: Не начислили баллы [#T-12]');
    expect(replySubject('Re: Не начислили баллы [#T-12]', 12)).toBe('Re: Не начислили баллы [#T-12]');
    expect(replySubject('', 3)).toBe('Re: Request [#T-3]');
  });

  it('extracts the ticket number from the subject', () => {
    expect(ticketNumberFromSubject('Re: Принтер [#T-42]')).toBe(42);
    expect(ticketNumberFromSubject('Принтер')).toBeNull();
  });
});

describe('threadHeaders', () => {
  const at = (minutes: number) => new Date(Date.UTC(2026, 9, 31, 10, minutes));

  it('replies to the customer\'s last email and builds References', () => {
    const headers = threadHeaders([
      { rfcMessageId: '<c1@x>', authorType: 'customer', createdAt: at(0) },
      { rfcMessageId: '<o1@us>', authorType: 'operator', createdAt: at(1) },
      { rfcMessageId: null, authorType: 'operator', createdAt: at(2) },
      { rfcMessageId: '<c2@x>', authorType: 'customer', createdAt: at(3) },
    ]);
    expect(headers).toEqual({ inReplyTo: '<c2@x>', references: ['<c1@x>', '<o1@us>', '<c2@x>'] });
  });

  it('limits References to ten: the first and the last ones', () => {
    const messages = Array.from({ length: 15 }, (_, i) => ({ rfcMessageId: `<m${i}@x>`, authorType: 'customer' as const, createdAt: at(i) }));
    const { references } = threadHeaders(messages);
    expect(references).toHaveLength(10);
    expect(references[0]).toBe('<m0@x>');
    expect(references.at(-1)).toBe('<m14@x>');
  });

  it('an empty thread', () => {
    expect(threadHeaders([])).toEqual({ inReplyTo: null, references: [] });
  });
});
