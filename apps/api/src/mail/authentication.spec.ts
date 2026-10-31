import { describe, expect, it } from 'vitest';
import { senderAuthenticated } from './authentication';

describe('senderAuthenticated', () => {
  it('DMARC pass, or DKIM pass with a signing domain aligned to From', () => {
    expect(senderAuthenticated('mx.example.com; spf=pass smtp.mailfrom=app.example; dmarc=pass (p=REJECT) header.from=app.example', 'noreply@app.example')).toBe(true);
    expect(senderAuthenticated('mx.example.com; dkim=pass header.d=app.example header.s=s1; spf=softfail', 'noreply@mail.app.example')).toBe(true);
    expect(senderAuthenticated('mx.example.com; dkim=pass header.i=@app.example', 'noreply@app.example')).toBe(true);
  });

  it('a failed check, or DKIM of another domain — not authenticated; no header — unknown', () => {
    expect(senderAuthenticated('mx.example.com; dkim=fail header.d=app.example; dmarc=fail', 'noreply@app.example')).toBe(false);
    expect(senderAuthenticated('mx.example.com; dkim=pass header.d=mailer.example', 'noreply@app.example')).toBe(false);
    expect(senderAuthenticated(null, 'noreply@app.example')).toBeNull();
  });
});
