import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import {
  DataSourceService,
  type CsvRawResult,
  type FtpConnection,
  type FtpListResult,
} from './data-source.service';

/**
 * Covers the remote (FTP/SFTP) browse + preview wiring: which endpoint a protocol
 * hits, and — the part that matters for credential hygiene — which secret rides in
 * the config. SFTP authenticates with the private key and plain FTP with the
 * control-channel password, so neither payload may carry the other's field.
 */
describe('DataSourceService remote browse (FTP/SFTP)', () => {
  let service: DataSourceService;
  let http: HttpTestingController;

  const FTP: FtpConnection = {
    protocol: 'FTP',
    host: 'ftp.example.com',
    port: '21',
    username: 'anon',
    password: 's3cret',
  };
  const SFTP: FtpConnection = {
    protocol: 'SFTP',
    host: 'ec2.example.com',
    port: '22',
    username: 'ec2-user',
    privateKey: '-----BEGIN RSA PRIVATE KEY-----\nabc\n',
  };

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [DataSourceService, provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(DataSourceService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('lists a plain-FTP directory against the ftp endpoint, sending the password', () => {
    service.listFtpDir(FTP, '/incoming').subscribe();
    const req = http.expectOne((r) => r.url.endsWith('/api/data-integration/introspect/ftp/list'));
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({
      config: { host: 'ftp.example.com', port: '21', username: 'anon', password: 's3cret', caseId: '' },
      path: '/incoming',
    });
    // No key material leaks into an FTP payload.
    expect(req.request.body.config.privateKey).toBeUndefined();
    req.flush({ ok: true, entries: [] });
  });

  it('lists an SFTP directory against the sftp endpoint, sending the private key', () => {
    service.listFtpDir(SFTP, '/').subscribe();
    const req = http.expectOne((r) => r.url.endsWith('/api/data-integration/introspect/sftp/list'));
    expect(req.request.body).toEqual({
      config: {
        host: 'ec2.example.com',
        port: '22',
        username: 'ec2-user',
        privateKey: '-----BEGIN RSA PRIVATE KEY-----\nabc\n',
        caseId: '',
      },
      path: '/',
    });
    // The password field is for FTP only — an SFTP payload must not carry one.
    expect(req.request.body.config.password).toBeUndefined();
    req.flush({ ok: true, entries: [] });
  });

  it('returns the listing entries classified by the backend, folders included', () => {
    let result: FtpListResult | undefined;
    service.listFtpDir(FTP, '/').subscribe((r) => (result = r));
    http.expectOne((r) => r.url.includes('/ftp/list')).flush({
      ok: true,
      entries: [
        { name: 'archive', type: 'folder' },
        { name: 'orders.csv', type: 'csv' },
        { name: 'notes.txt', type: 'file' },
      ],
    });
    expect(result?.ok).toBe(true);
    expect(result?.entries?.map((e) => e.type)).toEqual(['folder', 'csv', 'file']);
  });

  it('passes a failed listing through as { ok:false, message } for the UI to render', () => {
    let result: FtpListResult | undefined;
    service.listFtpDir(FTP, '/nope').subscribe((r) => (result = r));
    http.expectOne((r) => r.url.includes('/ftp/list'))
      .flush({ ok: false, message: 'Could not read "/nope": 550 Not found' });
    expect(result).toEqual({ ok: false, message: 'Could not read "/nope": 550 Not found' });
  });

  it('previews a plain-FTP CSV as RAW rows, header not applied', () => {
    let result: CsvRawResult | undefined;
    service.previewRemoteCsv(FTP, '/incoming/orders.csv').subscribe((r) => (result = r));
    const req = http.expectOne((r) => r.url.endsWith('/api/data-integration/introspect/ftp/preview'));
    expect(req.request.body.path).toBe('/incoming/orders.csv');
    req.flush({ ok: true, rows: [['id', 'name'], ['1', 'Acme']] });
    // The header row comes back as data — the component decides what row 0 means.
    expect(result?.rows).toEqual([['id', 'name'], ['1', 'Acme']]);
  });

  it('previews an SFTP CSV against the sftp preview endpoint', () => {
    service.previewRemoteCsv(SFTP, '/home/ec2-user/orders.csv').subscribe();
    const req = http.expectOne((r) => r.url.endsWith('/api/data-integration/introspect/sftp/preview'));
    expect(req.request.body.config.privateKey).toContain('BEGIN RSA PRIVATE KEY');
    req.flush({ ok: true, rows: [] });
  });

  it('sends empty strings rather than undefined for unfilled Step-1 fields', () => {
    service.listFtpDir({ protocol: 'FTP' }, '/').subscribe();
    const req = http.expectOne((r) => r.url.includes('/ftp/list'));
    expect(req.request.body.config).toEqual({ host: '', port: '', username: '', password: '', caseId: '' });
    req.flush({ ok: false, message: 'Listing failed: Host is required.' });
  });
});
