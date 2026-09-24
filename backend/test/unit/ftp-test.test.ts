import { describe, it, expect, vi } from 'vitest';
import {
  testFtpConnection,
  type FtpAccessOptions,
  type FtpClientLike,
  type FtpClientFactory,
} from '../../src/util/ftp-test.js';

const goodConfig = {
  host: 'ftp.example.com',
  port: '21',
  username: 'ftpuser',
  password: 's3cret',
};

/**
 * Build a fake basic-ftp Client driven by the given behavior, so the tests
 * exercise every path without a live FTP server.
 */
function fakeFactory(
  behavior: { accessErr?: Error; pwdErr?: Error; cwd?: string },
  spies?: { onClose?: () => void; onAccess?: (options: FtpAccessOptions) => void },
): FtpClientFactory {
  return () => {
    const client: FtpClientLike = {
      async access(options) {
        spies?.onAccess?.(options);
        if (behavior.accessErr) throw behavior.accessErr;
        return {};
      },
      async pwd() {
        if (behavior.pwdErr) throw behavior.pwdErr;
        return behavior.cwd ?? '/home/ftpuser';
      },
      close() {
        spies?.onClose?.();
      },
    };
    return client;
  };
}

describe('testFtpConnection', () => {
  it('returns ok when login and PWD succeed, and closes the connection', async () => {
    const onClose = vi.fn();
    const onAccess = vi.fn();
    const result = await testFtpConnection(
      goodConfig,
      fakeFactory({ cwd: '/uploads' }, { onClose, onAccess }),
    );
    expect(result.ok).toBe(true);
    expect(result.message).toContain('ftpuser');
    expect(result.message).toContain('/uploads');
    expect(onClose).toHaveBeenCalledOnce();
    expect(onAccess).toHaveBeenCalledWith({
      host: 'ftp.example.com',
      port: 21,
      user: 'ftpuser',
      password: 's3cret',
      secure: false,
    });
  });

  it('defaults to port 21 when the port is blank', async () => {
    const onAccess = vi.fn();
    const result = await testFtpConnection({ ...goodConfig, port: '' }, fakeFactory({}, { onAccess }));
    expect(result.ok).toBe(true);
    expect(onAccess).toHaveBeenCalledWith(expect.objectContaining({ port: 21 }));
  });

  it('allows a blank password (anonymous login)', async () => {
    const onAccess = vi.fn();
    const result = await testFtpConnection(
      { host: 'ftp.example.com', username: 'anonymous' },
      fakeFactory({}, { onAccess }),
    );
    expect(result.ok).toBe(true);
    expect(onAccess).toHaveBeenCalledWith(expect.objectContaining({ password: '' }));
  });

  it('reports failure when login is rejected, and still closes the connection', async () => {
    const onClose = vi.fn();
    const result = await testFtpConnection(
      goodConfig,
      fakeFactory({ accessErr: new Error('530 Login incorrect') }, { onClose }),
    );
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Connection or authentication failed/);
    expect(result.message).toContain('530 Login incorrect');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('reports failure when the host is unreachable', async () => {
    const result = await testFtpConnection(
      goodConfig,
      fakeFactory({ accessErr: new Error('connect ETIMEDOUT 10.0.0.1:21') }),
    );
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Connection or authentication failed/);
    expect(result.message).toContain('ETIMEDOUT');
  });

  it('reports failure when logged in but the PWD command fails', async () => {
    const result = await testFtpConnection(goodConfig, fakeFactory({ pwdErr: new Error('550 Permission denied') }));
    expect(result.ok).toBe(false);
    expect(result.message).toContain('550 Permission denied');
  });

  it('fails fast when the host is missing (no connection attempt)', async () => {
    const onAccess = vi.fn();
    const result = await testFtpConnection({ ...goodConfig, host: '' }, fakeFactory({}, { onAccess }));
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Host is required/);
    expect(onAccess).not.toHaveBeenCalled();
  });

  it('fails fast when the username is missing (no connection attempt)', async () => {
    const onAccess = vi.fn();
    const result = await testFtpConnection({ ...goodConfig, username: '  ' }, fakeFactory({}, { onAccess }));
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Username is required/);
    expect(onAccess).not.toHaveBeenCalled();
  });

  it('rejects an invalid port without connecting', async () => {
    const onAccess = vi.fn();
    const result = await testFtpConnection({ ...goodConfig, port: 'abc' }, fakeFactory({}, { onAccess }));
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/invalid port/);
    expect(onAccess).not.toHaveBeenCalled();
  });
});
