import { posix as posixPath } from 'node:path';
import type { NativeClient } from './native-client.js';
import { IrisProtocolError } from './iris-error.js';

/**
 * Write a user-uploaded file INTO the user's IRIS container, and delete it,
 * using only built-in IRIS classes over the Native SDK — no Workbench class is
 * installed in IRIS (the project's standing rule).
 *
 * The backend has no access to the IRIS container's filesystem; the two are
 * isolated containers with no shared mount (that is the whole point of not using
 * a shared volume). What the backend DOES have is the Native SDK command channel
 * (superserver port 1972) it already uses for cube builds and production edits.
 * So we do not write IRIS's disk directly — we hand IRIS the bytes and have IRIS
 * run its own file-writing code (`%Stream.FileBinary`) to save them locally.
 *
 * The exact APIs are the ones the InterSystems docs confirm:
 *   - `%Library.File.CreateDirectoryChain(dir)` — mkdir -p the target directory.
 *   - `%Stream.FileBinary` — the stream class "to store binary data in an external
 *     file": `FilenameSet(path)` (preferred over `Set .Filename=` because it
 *     returns a checkable %Status), `Write(data)` (appends bytes), `%Save()`.
 *   - `%SYSTEM.Encryption.Base64Decode(text)` — the Native SDK marshals STRINGS,
 *     not raw binary, so each chunk is base64 over the wire and decoded to bytes
 *     inside IRIS before Write. `%Stream.FileBinary` writes the decoded bytes
 *     verbatim (a `.pem` or a CSV with odd encoding round-trips losslessly).
 *   - `%Library.File.SetUMask(mask)` — for a secret (key/credentials) file we set
 *     the process umask to 0177 so the file is CREATED 0600 (owner rw only), then
 *     restore the previous umask. There is no `%Library.File` chmod-to-arbitrary-
 *     mode method, and creating-with-umask closes the brief window a post-write
 *     chmod would leave where a private key sits world-readable. The umask is
 *     process-wide, so it is scoped to secret writes only and always restored.
 *
 * Every method here returns a %Status; a non-OK status throws IrisProtocolError
 * so the route surfaces the usual `{ error, code }` envelope.
 */

/** IRIS built-in class names. */
const STREAM_FILE_BINARY = '%Stream.FileBinary';
const LIBRARY_FILE = '%Library.File';
const ENCRYPTION = '%SYSTEM.Encryption';

/**
 * Bytes written per `Write` call. The bytes are base64-encoded for the wire, so
 * the actual argument string is ~4/3 of this. 48 KB keeps each call comfortably
 * small while avoiding a call per handful of bytes for a multi-MB CSV.
 */
const CHUNK_BYTES = 48 * 1024;

/** umask that makes a newly created file 0600 (0666 & ~0177). */
const SECRET_UMASK = 0o177;

export interface PutFileArgs {
  /** Absolute POSIX path INSIDE the IRIS container, e.g. /tmp/sco-workbench/keys/<id>_key.pem. */
  irisPath: string;
  /** The file's raw bytes (as staged on the app-side volume). */
  bytes: Buffer;
  /** A secret (SSH/AWS key/credentials) file → created 0600. Default false. */
  secret?: boolean;
}

/**
 * Materialize `bytes` at `irisPath` inside the IRIS container. Creates the
 * parent directory chain. For `secret` files the umask is tightened so the file
 * is created 0600 and always restored afterward, even if the write throws.
 */
export function putFileToIris(native: NativeClient, args: PutFileArgs): void {
  const { irisPath, bytes, secret = false } = args;

  // Tighten umask BEFORE the file is created so it is born 0600 — restored in
  // finally. Read the previous mask back as a number so we can restore exactly.
  // Only keep it for restore if it parsed to a real number: restoring NaN would
  // corrupt the shared IRIS process umask for every later file it creates, so if
  // we can't read a clean prior value we leave the umask as-is rather than break it.
  let prevMask: number | undefined;
  if (secret) {
    const raw = Number(native.callValue(LIBRARY_FILE, 'SetUMask', SECRET_UMASK));
    prevMask = Number.isInteger(raw) ? raw : undefined;
  }
  try {
    // mkdir -p the directory. CreateDirectoryChain returns 1 on success (and is a
    // no-op when the chain already exists); a false return means we could not
    // create it, so fail loudly rather than let the stream save report a vaguer error.
    const dir = posixPath.dirname(irisPath);
    const dirOk = native.callValue(LIBRARY_FILE, 'CreateDirectoryChain', dir);
    if (dirOk !== 1 && dirOk !== 1n && dirOk !== '1' && dirOk !== true) {
      throw new IrisProtocolError(`Could not create directory "${dir}" in SCO.`);
    }

    const stream = native.callObject(STREAM_FILE_BINARY, '%New');
    if (!stream) throw new IrisProtocolError('Could not create a %Stream.FileBinary in SCO.');

    // Prefer FilenameSet() over `Set .Filename=`: it returns a %Status we can
    // check (a missing directory, a bad path) instead of forcing us to read %objlasterror.
    throwIfStatus(native, stream.invokeString('FilenameSet', irisPath), `set filename "${irisPath}"`);

    // Write the bytes in base64 chunks; IRIS decodes each back to raw bytes.
    for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
      const b64 = bytes.subarray(offset, offset + CHUNK_BYTES).toString('base64');
      const raw = native.callValue(ENCRYPTION, 'Base64Decode', b64);
      throwIfStatus(native, stream.invokeString('Write', raw), `write to "${irisPath}"`);
    }

    // An empty file writes no chunks; %Save still creates the zero-byte file.
    throwIfStatus(native, stream.invokeString('%Save'), `save "${irisPath}"`);
  } finally {
    if (prevMask !== undefined) native.callValue(LIBRARY_FILE, 'SetUMask', prevMask);
  }
}

/**
 * Delete a previously materialized file from the IRIS container. Best-effort:
 * `%Library.File.Delete` returns 1 when the file was removed and 0 when it was
 * already absent — both are fine for cleanup, so a 0 is not an error here.
 */
export function deleteFileFromIris(native: NativeClient, irisPath: string): void {
  native.callValue(LIBRARY_FILE, 'Delete', irisPath);
}

/**
 * Whether a file already exists in the IRIS container. Used to make a repeat
 * push idempotent (skip re-writing an already-staged driver JAR). `%Library.File.Exists`
 * returns 1 when the file exists and 0 when it does not.
 */
export function fileExistsInIris(native: NativeClient, irisPath: string): boolean {
  const exists = native.callValue(LIBRARY_FILE, 'Exists', irisPath);
  return exists === 1 || exists === 1n || exists === '1' || exists === true;
}

/** Throw IrisProtocolError with the decoded %Status text when a call failed. */
function throwIfStatus(native: NativeClient, status: unknown, action: string): void {
  const decoded = native.decodeStatus(status);
  if (!decoded.ok) throw new IrisProtocolError(`Failed to ${action} in SCO: ${decoded.text}`);
}
