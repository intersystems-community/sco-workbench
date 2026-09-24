// backend/test/unit/remote-fs/s3-fs.test.ts
import { describe, it, expect } from 'vitest';
import { S3FileSystem, type S3Api, type S3ApiFactory } from '../../../src/util/remote-fs/s3-fs.js';

const goodConfig = {
  bucket: 'my-bucket',
  region: 'us-east-1',
  accessKeyId: 'AKIA...',
  secretAccessKey: 'shhh',
};

function fakeFactory(api: Partial<S3Api>): S3ApiFactory {
  return () => ({
    list: api.list ?? (async () => ({ prefixes: [], keys: [] })),
    getRange: api.getRange ?? (async () => ''),
  });
}

describe('S3FileSystem.listDir', () => {
  it('maps common prefixes to folders and objects to csv/file, folders first', async () => {
    const fs = new S3FileSystem(goodConfig, fakeFactory({
      list: async () => ({ prefixes: ['raw/sales/'], keys: ['raw/summary.csv', 'raw/manifest.json'] }),
    }));
    const res = await fs.listDir('/raw');
    expect(res).toEqual({
      ok: true,
      entries: [
        { name: 'sales', type: 'folder' },
        { name: 'summary.csv', type: 'csv' },
        { name: 'manifest.json', type: 'file' },
      ],
    });
  });

  it('maps AccessDenied to a friendly failure', async () => {
    const fs = new S3FileSystem(goodConfig, fakeFactory({
      list: async () => { throw Object.assign(new Error('Access Denied'), { name: 'AccessDenied' }); },
    }));
    const res = await fs.listDir('/');
    expect(res).toEqual({ ok: false, message: expect.stringContaining('Access Denied') });
  });

  it('fails fast when the bucket is missing (no client built)', async () => {
    const res = await new S3FileSystem({ ...goodConfig, bucket: '' }, fakeFactory({})).listDir('/');
    expect(res.ok).toBe(false);
  });
});

describe('S3FileSystem.readPreview', () => {
  it('reads a bounded object range and returns raw rows', async () => {
    const fs = new S3FileSystem(goodConfig, fakeFactory({ getRange: async () => 'a,b\n1,2\n' }));
    const res = await fs.readPreview('/raw/summary.csv');
    expect(res).toEqual({ ok: true, rows: [['a', 'b'], ['1', '2']] });
  });

  it('maps NoSuchKey to a friendly failure', async () => {
    const fs = new S3FileSystem(goodConfig, fakeFactory({
      getRange: async () => { throw Object.assign(new Error('The specified key does not exist.'), { name: 'NoSuchKey' }); },
    }));
    const res = await fs.readPreview('/raw/missing.csv');
    expect(res).toEqual({ ok: false, message: expect.stringContaining('does not exist') });
  });
});
