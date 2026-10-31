import { describe, expect, it } from 'vitest';
import { extractReplyText } from './reply-text';

describe('extractReplyText', () => {
  it('cuts the Russian quote header of Gmail/Yandex', () => {
    expect(extractReplyText('Спасибо, заработало!\n\n31 окт. 2026 г., в 10:00, Поддержка <s@x.ru> пишет:\n> Перезагрузите')).toBe('Спасибо, заработало!');
  });

  it('cuts an Outlook quote', () => {
    expect(extractReplyText('Номер чека 000123\n\n-----Original Message-----\nFrom: s@x.ru\nSent: today')).toBe('Номер чека 000123');
    expect(extractReplyText('Ок\n\nОт: Поддержка\nОтправлено: 31 октября\nТема: Re: x')).toBe('Ок');
  });

  it('English template and ">" quotes', () => {
    expect(extractReplyText('Thanks!\n\nOn Fri, Oct 30, 2026 at 10:00 AM Support <s@x.com> wrote:\n> hello')).toBe('Thanks!');
  });

  it('if the whole email is a quote, returns it entirely', () => {
    expect(extractReplyText('> только цитата')).toBe('> только цитата');
  });
});
