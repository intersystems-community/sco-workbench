import { setApiToken, getApiToken, authHeaders } from './api';

describe('api token seam', () => {
  afterEach(() => setApiToken(''));

  it('authHeaders is empty when no token is set', () => {
    setApiToken('');
    expect(authHeaders()).toEqual({});
  });

  it('authHeaders carries a bearer when a token is set', () => {
    setApiToken('abc123');
    expect(authHeaders()).toEqual({ Authorization: 'Bearer abc123' });
    expect(getApiToken()).toBe('abc123');
  });

  it('treats null/undefined as no token', () => {
    setApiToken(null);
    expect(authHeaders()).toEqual({});
    setApiToken(undefined);
    expect(authHeaders()).toEqual({});
  });
});
