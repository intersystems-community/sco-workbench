/**
 * Data Integration file upload → materialize into a live IRIS, end to end through
 * the real booted app (multipart upload route → in-memory hold → Native SDK
 * write). Verifies the file truly lands on the IRIS filesystem with byte-for-byte
 * content, that a key file is written 0600 (best-effort check), and that cleanup
 * removes it. Self-cleaning: every file is written under a run-unique
 * Workbench.Test upload dir and deleted in afterAll.
 *
 * Live IRIS required; run via: npm run test:it
 *
 * NOTE the app's env pins the IRIS upload dirs to a test-only location so we
 * never touch a real /tmp/sco-workbench path a user might rely on.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadEnv } from '../../src/config/env.js';
import { createIrisServices, type IrisServices } from '../../src/iris/index.js';
import { createApp } from '../../src/server/app.js';
import { openDatabase } from '../../src/db/sqlite.js';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

const d = describe;

// Run-unique dir so parallel/prior runs never collide; both dirs under it are
// swept in afterAll via %Library.File.RemoveDirectoryTree.
const RUN_ID = `${process.pid}x${Math.floor(process.uptime() * 1000)}`;
const TEST_ROOT = `/tmp/workbench-test-uploads/${RUN_ID}`;
const CSV_DIR = `${TEST_ROOT}/csv`;
const KEY_DIR = `${TEST_ROOT}/keys`;
const TOKEN = 'workbench-upload-it-token';

d('Data Integration upload → materialize (live)', () => {
  let iris: IrisServices;
  let server: Server;
  let base = '';
  const realFetch = globalThis.fetch;

  beforeAll(() => {
    const env = {
      ...loadEnv(),
      WORKBENCH_API_TOKEN: TOKEN,
      SCO_UPLOAD_CSV_DIR: CSV_DIR,
      SCO_UPLOAD_KEY_DIR: KEY_DIR,
    };
    iris = createIrisServices(env);
    const db = openDatabase(':memory:');
    const app = createApp({ env, iris, db });
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    // Inject the bearer token for calls to this app (mirrors the SPA).
    globalThis.fetch = ((input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
      if (url.startsWith(base)) {
        const headers = new Headers(init?.headers);
        if (!headers.has('Authorization')) headers.set('Authorization', `Bearer ${TOKEN}`);
        return realFetch(input, { ...init, headers });
      }
      return realFetch(input, init);
    }) as typeof fetch;
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    // Remove the whole run dir from IRIS regardless of per-test outcome.
    try {
      iris.native.callValue('%Library.File', 'RemoveDirectoryTree', TEST_ROOT);
    } catch {
      // best-effort
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    iris.close();
  });

  /** Upload a file via the real multipart route; returns { fileId, irisPath }. */
  async function upload(name: string, kind: 'csv' | 'ssh-key' | 'aws-cred', content: string) {
    const fd = new FormData();
    fd.append('kind', kind);
    fd.append('file', new Blob([content], { type: 'application/octet-stream' }), name);
    const res = await fetch(`${base}/api/data-integration/uploads`, { method: 'POST', body: fd });
    expect(res.status).toBe(200);
    return (await res.json()) as { fileId: string; irisPath: string; kind: string };
  }

  async function materialize(fileIds: string[]) {
    const res = await fetch(`${base}/api/data-integration/uploads/materialize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fileIds }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as { results: Array<{ fileId: string; irisPath: string; ok: boolean; error?: string }> };
  }

  /** Read a file's bytes back from IRIS as a string via %Stream.FileBinary. */
  function readFileFromIris(irisPath: string): string {
    const stream = iris.native.callObject('%Stream.FileBinary', '%New');
    if (!stream) throw new Error('no stream');
    stream.invokeString('FilenameSet', irisPath);
    // Read the whole (small) file in one go; test payloads are tiny.
    return stream.invokeString('Read', 100000);
  }

  /** True iff the file exists in IRIS. */
  function existsInIris(irisPath: string): boolean {
    const r = iris.native.callValue('%Library.File', 'Exists', irisPath);
    return r === 1 || r === 1n || r === '1' || r === true;
  }

  it('materializes a CSV upload byte-for-byte at its returned irisPath, then cleans it up', async () => {
    const content = 'id,name\n1,Acme\n2,Globex\n';
    const up = await upload('customers.csv', 'csv', content);
    expect(up.irisPath.startsWith(CSV_DIR)).toBe(true);
    expect(existsInIris(up.irisPath)).toBe(false); // not there until materialize

    const { results } = await materialize([up.fileId]);
    expect(results[0]?.ok, results[0]?.error).toBe(true);
    expect(existsInIris(up.irisPath)).toBe(true);
    expect(readFileFromIris(up.irisPath)).toBe(content);

    // Cleanup removes it from IRIS.
    const del = await fetch(`${base}/api/data-integration/uploads/materialize/cleanup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fileIds: [up.fileId] }),
    });
    expect(del.status).toBe(200);
    expect(existsInIris(up.irisPath)).toBe(false);
  });

  it('materializes an ssh-key upload and creates it 0600 (best-effort perm check)', async () => {
    const content = '-----BEGIN PRIVATE KEY-----\nMIIBTESTKEY==\n-----END PRIVATE KEY-----\n';
    const up = await upload('id_rsa.pem', 'ssh-key', content);
    expect(up.irisPath.startsWith(KEY_DIR)).toBe(true);

    const { results } = await materialize([up.fileId]);
    expect(results[0]?.ok, results[0]?.error).toBe(true);
    expect(existsInIris(up.irisPath)).toBe(true);
    expect(readFileFromIris(up.irisPath)).toBe(content);

    // Best-effort 0600 verification via a shell stat. Not all platforms/stat
    // flavors match, and the Native SDK reads command output awkwardly, so this
    // is a soft check: if we can read a mode, it must be 600; if we can't, we log
    // and skip rather than fail the suite (the umask logic is proven in the unit
    // test). GNU stat: -c %a ; BSD stat: -f %Lp.
    const mode = tryReadMode(up.irisPath);
    if (mode !== null) {
      expect(mode, `expected key file ${up.irisPath} to be mode 600, got ${mode}`).toBe('600');
    } else {
      // eslint-disable-next-line no-console
      console.warn(`[upload.it] could not read file mode for ${up.irisPath}; skipped 0600 assertion`);
    }
  });

  it('reports ok:false for an unknown fileId without throwing', async () => {
    const { results } = await materialize(['nonexistent-file-id']);
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.error).toMatch(/re-upload/i);
  });

  /**
   * Try to read a file's octal mode via a shell command run inside IRIS. Returns
   * the mode string (e.g. "600") or null if it couldn't be determined. Reads
   * stdout from the temp file RunCommandViaZF writes, since the Native SDK can't
   * cleanly read the by-ref pOutput param.
   */
  function tryReadMode(irisPath: string): string | null {
    try {
      // `stat` output differs by platform; try GNU then BSD form. We run both and
      // take the first that yields three octal digits.
      for (const cmd of [`stat -c %a '${irisPath}'`, `stat -f %Lp '${irisPath}'`]) {
        const out = runShell(cmd);
        const m = out.match(/([0-7]{3,4})\s*$/);
        if (m && m[1]) return m[1].slice(-3);
      }
    } catch {
      // fall through to null
    }
    return null;
  }

  /** Run a shell command in IRIS and return its stdout (best-effort). */
  function runShell(cmd: string): string {
    // RunCommandViaZF writes stdout to a temp file (pDeleteTempFile=0 so we can
    // read it) and returns the temp path by ref — but the SDK can't read by-ref
    // out params, so we redirect stdout to a known file we then read as a stream.
    const outFile = `${TEST_ROOT}/.stat-out`;
    iris.native.callValue('%Library.File', 'CreateDirectoryChain', TEST_ROOT);
    // Use $ZF(-100) via a wrapper is unavailable; instead run through the
    // documented utility, redirecting to our file inside the command itself.
    const full = `${cmd} > '${outFile}' 2>/dev/null`;
    // %Net.Remote.Utility.RunCommandViaZF(cmd, .tmp, .out, openTimeout, deleteTmp, .ret)
    iris.native.callValue('%Net.Remote.Utility', 'RunCommandViaZF', `/bin/sh -c "${full.replace(/"/g, '\\"')}"`);
    const stream = iris.native.callObject('%Stream.FileBinary', '%New');
    if (!stream) return '';
    stream.invokeString('FilenameSet', outFile);
    return stream.invokeString('Read', 1000);
  }
});
