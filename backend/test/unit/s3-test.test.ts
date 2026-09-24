import { describe, it, expect, vi, afterEach } from 'vitest';
import { testS3Connection } from '../../src/util/s3-test.js';
import type { S3Api, S3ApiFactory, S3Config } from '../../src/util/remote-fs/s3-fs.js';

const goodConfig: S3Config = {
  bucket: 'my-bucket',
  region: 'us-east-1',
  accessKeyId: 'AKIAEXAMPLE',
  secretAccessKey: 'shhh',
};

/**
 * Fake the narrow S3Api seam so every path (success, empty bucket, SDK error,
 * hang) is exercised with no live bucket and no AWS credentials.
 */
function fakeFactory(
  api: Partial<S3Api>,
  spies?: { onCreate?: (config: S3Config) => void; onList?: (prefix: string) => void },
): S3ApiFactory {
  return (config) => {
    spies?.onCreate?.(config);
    return {
      list: async (prefix) => {
        spies?.onList?.(prefix);
        return api.list ? api.list(prefix) : { prefixes: [], keys: [] };
      },
      getRange: api.getRange ?? (async () => ''),
    };
  };
}

describe('testS3Connection', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('lists the BUCKET ROOT and reports the count on success', async () => {
    const onList = vi.fn();
    const result = await testS3Connection(
      goodConfig,
      fakeFactory({ list: async () => ({ prefixes: ['raw/'], keys: ['a.csv', 'b.csv'] }) }, { onList }),
    );
    expect(result.ok).toBe(true);
    expect(result.message).toContain('my-bucket');
    expect(result.message).toContain('us-east-1');
    expect(result.message).toContain('3 objects or folders');
    // The root prefix is '' — NOT '/', which S3 would treat as a literal key
    // segment and return nothing for, making a healthy bucket look empty.
    expect(onList).toHaveBeenCalledWith('');
  });

  it('treats an EMPTY bucket as a success (reachable + authorized, nothing in it)', async () => {
    const result = await testS3Connection(goodConfig, fakeFactory({ list: async () => ({ prefixes: [], keys: [] }) }));
    expect(result.ok).toBe(true);
    expect(result.message).toContain('empty');
  });

  it('uses the singular wording for exactly one entry', async () => {
    const result = await testS3Connection(goodConfig, fakeFactory({ list: async () => ({ prefixes: [], keys: ['only.csv'] }) }));
    expect(result.message).toContain('1 object or folder at');
  });

  it('passes the TRIMMED bucket and region to the client factory', async () => {
    const onCreate = vi.fn();
    await testS3Connection(
      { ...goodConfig, bucket: '  my-bucket  ', region: ' us-east-1 ' },
      fakeFactory({}, { onCreate }),
    );
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ bucket: 'my-bucket', region: 'us-east-1' }));
  });

  it('fails without calling out when a required field is missing', async () => {
    const onCreate = vi.fn();
    const factory = fakeFactory({}, { onCreate });
    const cases: [Partial<S3Config>, string][] = [
      [{ bucket: '   ' }, 'Bucket Name'],
      [{ region: '' }, 'Storage Region'],
      [{ accessKeyId: '  ' }, 'access key id'],
      [{ secretAccessKey: '' }, 'access key id'],
    ];
    for (const [override, expected] of cases) {
      const result = await testS3Connection({ ...goodConfig, ...override }, factory);
      expect(result.ok).toBe(false);
      expect(result.message).toContain(expected);
    }
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('maps bad credentials to a friendly failure instead of throwing', async () => {
    const result = await testS3Connection(goodConfig, fakeFactory({
      list: async () => { throw Object.assign(new Error('The AWS Access Key Id you provided does not exist in our records.'), { name: 'InvalidAccessKeyId' }); },
    }));
    expect(result.ok).toBe(false);
    expect(result.message).toContain('Access Key Id');
  });

  it('maps a missing bucket and a wrong-region redirect to failures', async () => {
    const noBucket = await testS3Connection(goodConfig, fakeFactory({
      list: async () => { throw Object.assign(new Error('The specified bucket does not exist'), { name: 'NoSuchBucket' }); },
    }));
    expect(noBucket).toEqual({ ok: false, message: expect.stringContaining('does not exist') });

    const redirect = await testS3Connection(goodConfig, fakeFactory({
      list: async () => { throw Object.assign(new Error('The bucket is in this region: us-west-2'), { name: 'PermanentRedirect' }); },
    }));
    expect(redirect).toEqual({ ok: false, message: expect.stringContaining('us-west-2') });
  });

  it('reports a non-Error rejection (an SDK can throw anything) without crashing', async () => {
    const result = await testS3Connection(goodConfig, fakeFactory({
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      list: async () => { throw 'socket hang up'; },
    }));
    expect(result).toEqual({ ok: false, message: expect.stringContaining('socket hang up') });
  });

  it('gives up instead of hanging when S3 never answers', async () => {
    vi.useFakeTimers();
    const pending = testS3Connection(goodConfig, fakeFactory({ list: () => new Promise(() => {}) }));
    await vi.advanceTimersByTimeAsync(15_000);
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.message).toContain('no response from S3');
  });

  it('does NOT time out a call that answers just before the deadline', async () => {
    vi.useFakeTimers();
    const pending = testS3Connection(goodConfig, fakeFactory({
      list: () => new Promise((resolve) => { setTimeout(() => resolve({ prefixes: [], keys: ['x.csv'] }), 14_000); }),
    }));
    await vi.advanceTimersByTimeAsync(14_000);
    await expect(pending).resolves.toEqual({ ok: true, message: expect.stringContaining('1 object') });
  });
});
