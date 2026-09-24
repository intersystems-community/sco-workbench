import { describe, it, expect, vi } from 'vitest';
import { testSftpConnection, type SshClientLike, type SshClientFactory } from '../../src/util/sftp-test.js';

const goodConfig = {
  host: 'ec2-1-2-3-4.compute.amazonaws.com',
  port: '22',
  username: 'ec2-user',
  privateKey: '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----',
};

/**
 * Build a fake ssh2 Client driven by the given behavior. Listeners are captured;
 * connect() fires the scripted event on the next tick (async, like the real one).
 */
function fakeFactory(
  behavior: { event: 'ready' | 'error'; error?: Error; sftpErr?: Error },
  spies?: { onEnd?: () => void; onConnect?: () => void },
): SshClientFactory {
  return () => {
    const listeners: Record<string, (arg?: unknown) => void> = {};
    const client: SshClientLike = {
      on(event, listener) {
        listeners[event] = listener;
        return this;
      },
      connect() {
        spies?.onConnect?.();
        queueMicrotask(() => {
          if (behavior.event === 'error') listeners.error?.(behavior.error ?? new Error('failed'));
          else listeners.ready?.();
        });
      },
      sftp(cb) {
        cb(behavior.sftpErr, {});
      },
      end() {
        spies?.onEnd?.();
      },
    };
    return client;
  };
}

describe('testSftpConnection', () => {
  it('returns ok when the connection is ready and the SFTP subsystem opens, and ends the connection', async () => {
    const onEnd = vi.fn();
    const result = await testSftpConnection(goodConfig, fakeFactory({ event: 'ready' }, { onEnd }));
    expect(result.ok).toBe(true);
    expect(result.message).toContain('ec2-user');
    expect(onEnd).toHaveBeenCalledOnce();
  });

  it('reports failure when authentication/connection errors', async () => {
    const result = await testSftpConnection(
      goodConfig,
      fakeFactory({ event: 'error', error: new Error('All configured authentication methods failed') }),
    );
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Connection or authentication failed/);
    expect(result.message).toContain('authentication methods failed');
  });

  it('reports failure when the connection is ready but opening SFTP fails', async () => {
    const result = await testSftpConnection(
      goodConfig,
      fakeFactory({ event: 'ready', sftpErr: new Error('SFTP disabled') }),
    );
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/opening SFTP failed/);
    expect(result.message).toContain('SFTP disabled');
  });

  it('fails fast when the private key is missing (no connection attempt)', async () => {
    const onConnect = vi.fn();
    const result = await testSftpConnection(
      { ...goodConfig, privateKey: '' },
      fakeFactory({ event: 'ready' }, { onConnect }),
    );
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/private key file is required/);
    expect(onConnect).not.toHaveBeenCalled();
  });

  it('fails fast when the host is missing', async () => {
    const result = await testSftpConnection({ ...goodConfig, host: '' }, fakeFactory({ event: 'ready' }));
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Host is required/);
  });

  it('rejects an invalid port without connecting', async () => {
    const onConnect = vi.fn();
    const result = await testSftpConnection(
      { ...goodConfig, port: 'abc' },
      fakeFactory({ event: 'ready' }, { onConnect }),
    );
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/invalid port/);
    expect(onConnect).not.toHaveBeenCalled();
  });
});
