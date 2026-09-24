// frontend/src/app/dashboard/table-tile-view.spec.ts
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Component } from '@angular/core';
import { Observable, of, throwError } from 'rxjs';
import { HttpErrorResponse } from '@angular/common/http';
import { TableTileViewComponent } from './table-tile-view';
import { ScModelService } from '../services/sc-model.service';
import { ScDataService, type ScDataPage } from '../services/sc-data.service';
import { DataBrowserService, type CountResult } from '../services/data-browser.service';

const OBJECTS = [
  { objectName: 'Carrier', className: 'SC.Data.Carrier', description: 'Carriers', isCustom: false },
  { objectName: 'Nowhere', className: 'SC.Data.Nowhere', description: 'Unmapped', isCustom: false },
  { objectName: 'HelloWorld', className: 'SC.Data.HelloWorld', description: 'Custom', isCustom: true },
];

const CARRIER_DETAIL = {
  objectName: 'Carrier',
  className: 'SC.Data.Carrier',
  description: 'Carriers',
  attributes: [{ name: 'uid' }, { name: 'name' }, { name: 'trackingUrl' }],
};

function page(over: Partial<ScDataPage> = {}): ScDataPage {
  return { rows: [{ uid: 'C1', name: 'Acme' }], pageIndex: 0, pageSize: 50, returnCount: 1, orderBy: 'name ASC', ...over };
}

interface Fakes {
  objects?: Observable<unknown[]>;
  detail?: Observable<unknown>;
  rows?: () => Observable<ScDataPage>;
  count?: () => Observable<CountResult>;
}

@Component({ standalone: true, imports: [TableTileViewComponent], template: `<app-table-tile-view [selection]="sel" />` })
class Host {
  sel: { table: string; columns?: string[] } = { table: 'SC.Data.Carrier' };
}

function setup(fakes: Fakes = {}, table = 'SC.Data.Carrier') {
  const rowsImpl = fakes.rows ?? (() => of(page()));
  const getPage = vi.fn((_resource: string, _opts: { pageSize: number; pageIndex: number; sortBy?: string | null }) => rowsImpl());
  const getObjectDetail = vi.fn(() => fakes.detail ?? of(CARRIER_DETAIL));
  const getObjects = vi.fn(() => fakes.objects ?? of(OBJECTS));
  const countImpl = fakes.count ?? (() => of<CountResult>({ ok: true, total: 900, className: 'SC.Data.Carrier', sqlTableName: 'SC_Data.Carrier' }));
  const getCount = vi.fn((_className: string) => countImpl());

  TestBed.configureTestingModule({
    imports: [Host],
    providers: [
      { provide: ScModelService, useValue: { getObjects, getObjectDetail } },
      { provide: ScDataService, useValue: { getPage } },
      { provide: DataBrowserService, useValue: { getCount } },
    ],
  });
  const fixture: ComponentFixture<Host> = TestBed.createComponent(Host);
  fixture.componentInstance.sel = { table };
  return { fixture, getPage, getObjectDetail, getObjects, getCount };
}

async function settle(fixture: ComponentFixture<Host>) {
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('TableTileViewComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('renders a data-grid with the fetched rows/columns', async () => {
    const { fixture, getPage, getObjectDetail } = setup();
    const el = await settle(fixture);
    expect(getObjectDetail).toHaveBeenCalledWith('Carrier');
    expect(getPage).toHaveBeenCalledWith('carriers', { pageSize: 50, pageIndex: 0, sortBy: null });
    expect(el.querySelector('app-data-grid')).toBeTruthy();
    // columns from scmodel (including one absent from the rows), humanized headers
    expect(Array.from(el.querySelectorAll('th')).map((th) => th.textContent?.trim().replace(/\s+/g, '')))
      .toEqual(['UID', 'Name', 'TrackingURL']);
    expect(el.querySelectorAll('tbody tr')).toHaveLength(1);
  });

  it('projects the grid columns to selection.columns, in that order', async () => {
    const { fixture } = setup();
    fixture.componentInstance.sel = { table: 'SC.Data.Carrier', columns: ['name', 'uid'] };
    const el = await settle(fixture);
    expect(Array.from(el.querySelectorAll('th')).map((th) => th.textContent?.trim().replace(/\s+/g, '')))
      .toEqual(['Name', 'UID']); // scmodel order is uid,name,trackingUrl — projection reorders + drops
  });

  it('drops a stored column that is no longer in the source', async () => {
    const { fixture } = setup();
    fixture.componentInstance.sel = { table: 'SC.Data.Carrier', columns: ['name', 'ghost', 'uid'] };
    const el = await settle(fixture);
    expect(Array.from(el.querySelectorAll('th')).map((th) => th.textContent?.trim().replace(/\s+/g, '')))
      .toEqual(['Name', 'UID']); // 'ghost' is not an available column → dropped
  });

  it('falls back to all columns when the stored subset intersects nothing', async () => {
    const { fixture } = setup();
    fixture.componentInstance.sel = { table: 'SC.Data.Carrier', columns: ['gone1', 'gone2'] };
    const el = await settle(fixture);
    expect(Array.from(el.querySelectorAll('th')).map((th) => th.textContent?.trim().replace(/\s+/g, '')))
      .toEqual(['UID', 'Name', 'TrackingURL']); // empty intersection → all columns, tile stays useful
  });

  it('falls back to the union of row keys when the detail call fails', async () => {
    const { fixture } = setup({
      detail: throwError(() => new Error('no detail')),
      rows: () => of(page({ rows: [{ uid: 'C1' }, { name: 'Acme', extra: 1 }], returnCount: 2 })),
    });
    const el = await settle(fixture);
    expect(Array.from(el.querySelectorAll('th')).map((th) => th.textContent?.trim())).toEqual(['UID', 'Name', 'Extra']);
    // derived columns are not offered as sortable (GetOrderByClause rejects unknown columns)
    expect(el.querySelectorAll('th button')).toHaveLength(0);
  });

  it('shows a per-tile error (not a throw) with a retry when getPage fails', async () => {
    let attempt = 0;
    const { fixture, getPage } = setup({ rows: () => (attempt++ === 0 ? throwError(() => new Error('rows boom')) : of(page())) });
    const el = await settle(fixture);
    expect(el.querySelector('.tile-error')?.textContent).toContain('rows boom');
    el.querySelector<HTMLElement>('.tile-error button')?.click();
    await fixture.whenStable(); fixture.detectChanges();
    expect(getPage).toHaveBeenCalledTimes(2);
    expect(el.querySelector('.tile-error')).toBeFalsy();
  });

  it('a source with no scdata resource shows a distinct "source unavailable" state and fetches no rows', async () => {
    const { fixture, getPage } = setup({}, 'SC.Data.Nowhere');
    const el = await settle(fixture);
    expect(el.querySelector('.tile-source-gone')).toBeTruthy();
    expect(el.textContent).toContain('no longer available');
    expect(getPage).not.toHaveBeenCalled();
  });

  it('a table no longer in the catalog shows the "source unavailable" state (config points at a gone table)', async () => {
    const { fixture, getPage } = setup({ objects: of(OBJECTS) }, 'SC.Data.Deleted');
    const el = await settle(fixture);
    expect(el.querySelector('.tile-source-gone')).toBeTruthy();
    expect(getPage).not.toHaveBeenCalled();
  });

  it('fetches the row total once on load and still pages via getPage', async () => {
    const { fixture, getPage, getCount } = setup({ rows: () => of(page({ returnCount: 50, pageSize: 50 })) });
    const el = await settle(fixture);
    expect(getCount).toHaveBeenCalledTimes(1);
    expect(getCount).toHaveBeenCalledWith('SC.Data.Carrier');
    el.querySelector<HTMLElement>('[data-testid="next"]')?.click();
    await fixture.whenStable(); fixture.detectChanges();
    // The count is fetched once on load, not per page.
    expect(getCount).toHaveBeenCalledTimes(1);
    expect(getPage.mock.calls.map((c) => c[1].pageIndex)).toEqual([0, 1]);
  });

  it('a known total upgrades the range label to "… of N"', async () => {
    const { fixture } = setup({
      rows: () => of(page({ returnCount: 50, pageSize: 50 })),
      count: () => of<CountResult>({ ok: true, total: 900, className: 'SC.Data.Carrier', sqlTableName: 'SC_Data.Carrier' }),
    });
    const el = await settle(fixture);
    expect(el.querySelector('[data-testid="range"]')?.textContent).toContain('of 900');
  });

  it('a failed count leaves the total unknown and still pages via the sentinel', async () => {
    const { fixture, getPage } = setup({
      rows: () => of(page({ returnCount: 50, pageSize: 50 })),
      count: () => of<CountResult>({ ok: false, error: 'boom', candidates: [] }),
    });
    const el = await settle(fixture);
    expect(el.querySelector('[data-testid="range"]')?.textContent).not.toContain('of');
    // A full page still offers Next via the returnCount sentinel.
    expect(el.querySelector<HTMLButtonElement>('[data-testid="next"]')?.disabled).toBe(false);
    el.querySelector<HTMLElement>('[data-testid="next"]')?.click();
    await fixture.whenStable(); fixture.detectChanges();
    expect(getPage.mock.calls.map((c) => c[1].pageIndex)).toEqual([0, 1]);
  });

  it('jumps to the last page then back to the first, refetching each time (total known)', async () => {
    const { fixture, getPage } = setup({
      rows: () => of(page({ returnCount: 50, pageSize: 50 })),
      count: () => of<CountResult>({ ok: true, total: 900, className: 'SC.Data.Carrier', sqlTableName: 'SC_Data.Carrier' }),
    });
    const el = await settle(fixture);
    el.querySelector<HTMLElement>('[data-testid="last"]')?.click();
    await fixture.whenStable(); fixture.detectChanges();
    el.querySelector<HTMLElement>('[data-testid="first"]')?.click();
    await fixture.whenStable(); fixture.detectChanges();
    // 900 rows / 50 → last page index 17; then first → 0.
    expect(getPage.mock.calls.map((c) => c[1].pageIndex)).toEqual([0, 17, 0]);
  });

  it('reverts the sort and keeps the rows when the server rejects a sortBy', async () => {
    let call = 0;
    const { fixture } = setup({
      rows: () => {
        call += 1;
        if (call === 2) return throwError(() => new HttpErrorResponse({ status: 500, statusText: 'Internal Server Error' }));
        return of(page());
      },
    });
    const el = await settle(fixture);
    el.querySelectorAll<HTMLElement>('th button')[1]?.click(); // sort by "name"
    await fixture.whenStable(); fixture.detectChanges();
    expect(el.querySelector('.tile-sort-error')?.textContent).toContain('name');
    expect(el.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(el.querySelector('th.is-sorted')).toBeNull();
    expect(el.querySelector('.tile-error')).toBeFalsy();
  });

  // Redesign R8 (spec §12): the tile body bounds its content and the view fills it,
  // so the data-grid's own scroll region (which owns the horizontal bar) is the
  // bounded scroll container — bars inside the frame, not below the fold. A percentage
  // height only resolves if every ancestor is sized, so this host must fill its parent.
  it('fills its host so the inner data-grid scroll region is bounded (height:100%)', async () => {
    const { fixture } = setup();
    const el = await settle(fixture);
    const host = el.querySelector('app-table-tile-view') as HTMLElement;
    // Emulated encapsulation stamps the host with `_nghost-<id>` and compiles its
    // `:host` rule to `[_nghost-<id>]{…}`. Match THIS host's own rule.
    const nghost = Array.from(host.attributes).map((a) => a.name).find((n) => n.startsWith('_nghost'));
    expect(nghost).toBeTruthy();
    const css = Array.from(document.querySelectorAll('style')).map((s) => s.textContent ?? '').join('\n');
    expect(css).toMatch(new RegExp(`\\[${nghost}\\][^{]*\\{[^}]*height:\\s*100%`));
  });

  it('reloads when the selection input changes to a different table', async () => {
    const rowsImpl = () => of(page());
    const getPage = vi.fn((_resource: string, _opts: { pageSize: number; pageIndex: number; sortBy?: string | null }) => rowsImpl());
    const getObjectDetail = vi.fn(() => of(CARRIER_DETAIL));
    const getObjects = vi.fn(() => of(OBJECTS));
    TestBed.configureTestingModule({
      providers: [
        { provide: ScModelService, useValue: { getObjects, getObjectDetail } },
        { provide: ScDataService, useValue: { getPage } },
        { provide: DataBrowserService, useValue: { getCount: vi.fn(() => of<CountResult>({ ok: false, error: 'x', candidates: [] })) } },
      ],
    });
    const fixture = TestBed.createComponent(TableTileViewComponent);
    fixture.componentRef.setInput('selection', { table: 'SC.Data.Carrier' });
    fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges();
    expect(getObjectDetail).toHaveBeenLastCalledWith('Carrier');

    fixture.componentRef.setInput('selection', { table: 'SC.Data.HelloWorld' });
    fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges();
    expect(getObjectDetail).toHaveBeenLastCalledWith('HelloWorld');
    // custom object → derived scdata path
    expect(getPage.mock.calls.at(-1)?.[0]).toBe('helloworlds');
  });
});
