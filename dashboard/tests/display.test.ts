import { describe, expect, it } from 'vitest';
import { gmailLink, pct, replyExcerpt } from '../src/lib/display';

const BASE = 'https://mail.google.com/mail/u/0/#all';

describe('gmail deep links', () => {
  it('addresses the thread directly when we have a thread id', () => {
    expect(gmailLink(BASE, { payload: { gmailThreadId: '18f0abc' } })).toBe(`${BASE}/18f0abc`);
  });

  it('falls back to a stored thread url', () => {
    expect(
      gmailLink(BASE, { payload: null, gmailThreadUrl: 'https://mail.google.com/mail/u/0/#all/xyz' }),
    ).toBe('https://mail.google.com/mail/u/0/#all/xyz');
  });

  it('searches by Message-ID when that is all we have, stripping the angle brackets', () => {
    expect(gmailLink(BASE, { payload: { messageId: '<abc@mail.example>' } })).toBe(
      `${BASE}/rfc822msgid:${encodeURIComponent('abc@mail.example')}`,
    );
  });

  it('returns null rather than a broken link when we have nothing to point at', () => {
    expect(gmailLink(BASE, { payload: null })).toBeNull();
    expect(gmailLink(BASE, { payload: { unrelated: 1 } })).toBeNull();
  });
});

describe('honest display', () => {
  it('shows a dash, not a zero, when a rate is deliberately withheld', () => {
    expect(pct(null)).toBe('—');
    expect(pct(0)).toBe('0.0%');
    expect(pct(0.0512)).toBe('5.1%');
  });

  it('never invents reply text that was not captured', () => {
    expect(replyExcerpt(null)).toBeNull();
    expect(replyExcerpt({ excerpt: '   ' })).toBeNull();
    expect(replyExcerpt({ text: 'sure, send it over' })).toBe('sure, send it over');
  });
});
