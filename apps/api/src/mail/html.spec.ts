import { describe, expect, it } from 'vitest';
import { htmlToPlainText, sanitizeInboundHtml, sanitizeOperatorHtml, textToHtml } from './html';

describe('sanitizeInboundHtml', () => {
  it('strips scripts and handlers, blocks external images', () => {
    const html = sanitizeInboundHtml(
      '<p onclick="x()">Привет<script>alert(1)</script></p><img src="https://track.example.com/p.gif"><img src="cid:logo@x">',
    );
    expect(html).not.toContain('script');
    expect(html).not.toContain('onclick');
    expect(html).toContain('data-blocked-src="https://track.example.com/p.gif"');
    expect(html).not.toMatch(/\ssrc=/);
    expect(html).toContain('data-cid="logo@x"');
  });

  it('links open in a new window, javascript: is stripped', () => {
    const html = sanitizeInboundHtml('<a href="javascript:alert(1)">x</a><a href="https://ok.example">ok</a>');
    expect(html).not.toContain('javascript');
    expect(html).toContain('target="_blank"');
  });
});

describe('sanitizeOperatorHtml', () => {
  it('keeps formatting and removes the rest', () => {
    expect(sanitizeOperatorHtml('<p><b>Готово</b><img src=x onerror=1><iframe></iframe></p>')).toBe('<p><b>Готово</b></p>');
  });
});

describe('text helpers', () => {
  it('htmlToPlainText and textToHtml', () => {
    expect(htmlToPlainText('<p>Добрый день!</p><p>Баллы начислены.</p>')).toBe('Добрый день!\n\nБаллы начислены.');
    expect(textToHtml('Строка 1\nСтрока 2\n\n<b>')).toBe('<p>Строка 1<br>Строка 2</p><p>&lt;b&gt;</p>');
  });
});
