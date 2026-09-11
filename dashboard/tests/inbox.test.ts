import { describe, expect, it } from 'vitest';
import {
  channelLabel,
  inboxUrl,
  initials,
  nextDraftId,
  pageWindow,
  positiveId,
  queueParams,
  searchPattern,
} from '../src/lib/inbox.js';

describe('review queue navigation', () => {
  it('opens with the freshest drafts and all channels', () => {
    expect(queueParams(new URLSearchParams())).toEqual({
      q: '',
      filter: 'all',
      channel: 'all',
      sort: 'newest',
      page: 1,
      draft: null,
    });
  });
  it('restores a shared review URL', () => {
    expect(
      queueParams(
        new URLSearchParams('q=  Maya  &filter=priority&channel=email&sort=oldest&page=3&draft=97'),
      ),
    ).toEqual({
      q: 'Maya',
      filter: 'priority',
      channel: 'email',
      sort: 'oldest',
      page: 3,
      draft: 97,
    });
  });
  it('bounds searches and rejects unsupported filter values', () => {
    const filters = queueParams(
      new URLSearchParams({
        q: 'x'.repeat(200),
        filter: 'bogus',
        channel: 'smtp',
        sort: 'DROP TABLE',
        page: 'Infinity',
        draft: '1.5',
      }),
    );
    expect(filters).toMatchObject({
      filter: 'all',
      channel: 'all',
      sort: 'newest',
      page: 1,
      draft: null,
    });
    expect(filters.q).toHaveLength(120);
  });
  it.each(['0', '-1', '1.5', 'Infinity', '9007199254740992', '2e3', ''])(
    'rejects invalid ids: %s',
    (value) => expect(positiveId(value)).toBeNull(),
  );
  it('treats SQL wildcard characters as part of a company name', () => {
    expect(searchPattern('100%_real\\name')).toBe('%100\\%\\_real\\\\name%');
  });
  it('removes named actions while keeping the search and channel after approval', () => {
    const url = inboxUrl(
      '/',
      new URLSearchParams('/approve=&q=signal%20forge&channel=email&page=2&draft=80'),
      { draft: 81 },
    );
    const params = new URL(url, 'http://localhost').searchParams;
    expect(params.has('/approve')).toBe(false);
    expect(params.get('q')).toBe('signal forge');
    expect(params.get('channel')).toBe('email');
    expect(params.get('page')).toBe('2');
    expect(params.get('draft')).toBe('81');
  });
  it('clears selection when moving between pages', () => {
    expect(inboxUrl('/', new URLSearchParams('draft=80&q=maya'), { draft: null, page: 2 })).toBe(
      '/?q=maya&page=2',
    );
  });
  it('advances through the visible review order, including the last item', () => {
    expect(nextDraftId([8, 4, 2], 8)).toBe(4);
    expect(nextDraftId([8, 4, 2], 4)).toBe(2);
    expect(nextDraftId([8, 4, 2], 2)).toBe(4);
    expect(nextDraftId([8], 8)).toBeNull();
    expect(nextDraftId([], 8)).toBeNull();
  });
  it('clamps an empty last page after its final draft was approved', () => {
    expect(pageWindow(2, 25)).toEqual({ page: 1, pages: 1, offset: 0 });
    expect(pageWindow(3, 0)).toEqual({ page: 1, pages: 1, offset: 0 });
    expect(pageWindow(2, 26)).toEqual({ page: 2, pages: 2, offset: 25 });
  });
  it('shows readable channel names and honest missing identities', () => {
    expect(channelLabel('connect')).toBe('LinkedIn');
    expect(channelLabel('email')).toBe('Email');
    expect(initials(null)).toBe('?');
    expect(initials('  Maya  Chen ')).toBe('MC');
  });
});
