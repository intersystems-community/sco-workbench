import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { BiCubesComponent } from './bi-cubes';
import { ScModelService } from '../services/sc-model.service';
import { CubeService } from '../services/cube.service';
import { ToastService } from '../core/toast.service';

/**
 * The dimension editor's shape, after two changes:
 *
 *  - **The "Done" button is gone.** It duplicated the block header, which already
 *    collapses and expands the block, and its `done` flag added a third state
 *    (done / collapsed / expanded) that nothing else in the form had — measures
 *    collapse with the header alone. Collapsing IS "done" now.
 *  - **Levels are a reflowing grid, not a <table>.** A table can only shrink its
 *    columns, so with the AI chat dock open the Source and Time Function controls
 *    became unreadable. The `@container` rules in bi-cubes.css re-flow a level row
 *    into labelled fields that wrap — which requires each field to carry its own
 *    label in the markup, and the column headings to be a separate row that CSS can
 *    hide. These pins are about that structure being present; the widths themselves
 *    are CSS and not observable in jsdom.
 */
function setup() {
  TestBed.resetTestingModule();
  const scModel = { getObjects: vi.fn(() => of([{ objectName: 'SalesOrder', className: 'SC.Data.SalesOrder' }])) };
  const cubes = {
    list: vi.fn(() => of({ cubes: [] })),
    sourceProperties: vi.fn(() => of({ className: 'SC.Data.SalesOrder', properties: [{ name: 'orderPlacedDate' }] })),
  };
  const toasts = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() };
  TestBed.configureTestingModule({
    imports: [BiCubesComponent],
    providers: [
      { provide: ScModelService, useValue: scModel },
      { provide: CubeService, useValue: cubes },
      { provide: ToastService, useValue: toasts },
    ],
  });
  const fixture: ComponentFixture<BiCubesComponent> = TestBed.createComponent(BiCubesComponent);
  fixture.detectChanges();
  return { fixture, component: fixture.componentInstance, toasts };
}

/**
 * Re-render after driving the component from a test. The component is OnPush and
 * this app is zoneless, so a plain `detectChanges()` after poking form state raises
 * NG0100 in dev mode (the verify pass sees a value the first pass never refreshed).
 * Marking the host dirty first is the supported way to say "I changed state".
 */
function render(fixture: ComponentFixture<BiCubesComponent>): void {
  fixture.changeDetectorRef.markForCheck();
  fixture.detectChanges();
}

/** Open the create form with one dimension expanded. `named: false` leaves the
 *  dimension unnamed, as it arrives from + Add Dimension. */
function formWithDimension(kind: 'data' | 'time' = 'data', named = true) {
  const ctx = setup();
  ctx.component.openNewForm();
  ctx.component.addDimension();
  if (named) ctx.component.cubeForm.dimensions[0]!.name = 'orderPlacedDate';
  ctx.component.cubeForm.dimensions[0]!.type = kind;
  render(ctx.fixture);
  return ctx;
}

const host = (fixture: ComponentFixture<BiCubesComponent>) => fixture.nativeElement as HTMLElement;

describe('BiCubes dimension block — no redundant Done button', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('renders no Done button inside the dimension editor', () => {
    const { fixture } = formWithDimension();
    expect(host(fixture).querySelector('.dim-done-btn')).toBeNull();
    expect(host(fixture).querySelector('.dim-done-row')).toBeNull();
    const labels = Array.from(host(fixture).querySelectorAll('button')).map((b) => b.textContent?.trim());
    expect(labels).not.toContain('Done');
  });

  it('collapses and re-expands from the header alone', () => {
    const { fixture, component } = formWithDimension();
    const header = host(fixture).querySelector<HTMLElement>('.collapsible-header')!;

    expect(component.cubeForm.dimensions[0]!.expanded).toBe(true);
    header.click();
    render(fixture);
    expect(component.cubeForm.dimensions[0]!.expanded).toBe(false);
    // The body is gone, so the header summarises what's inside it instead.
    expect(host(fixture).querySelectorAll('.dim-summary-pill').length).toBe(2);

    header.click();
    render(fixture);
    expect(component.cubeForm.dimensions[0]!.expanded).toBe(true);
    // Expanded again: the body is back and the pills stand down.
    expect(host(fixture).querySelector('.levels-grid')).not.toBeNull();
    expect(host(fixture).querySelectorAll('.dim-summary-pill').length).toBe(0);
  });

  it('collapses a dimension that has no name yet', () => {
    // The old Done button was disabled until the dimension was named, which left a
    // half-filled block stuck open. Collapsing is presentation, so it never blocks.
    const { fixture, component } = formWithDimension('data', false);
    expect(component.cubeForm.dimensions[0]!.name).toBe('');

    host(fixture).querySelector<HTMLElement>('.collapsible-header')!.click();
    render(fixture);

    expect(component.cubeForm.dimensions[0]!.expanded).toBe(false);
  });
});

describe('BiCubes levels editor — reflowable structure', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('lays levels out as a grid rather than a table', () => {
    const { fixture } = formWithDimension();
    expect(host(fixture).querySelector('.levels-grid')).not.toBeNull();
    // No table inside the editable form — a table cannot reflow, only shrink.
    expect(host(fixture).querySelector('.levels-block table')).toBeNull();
  });

  it('gives every level field its own label for the wrapped layout', () => {
    // The column headings can't head a row that has wrapped onto three lines, so
    // each field carries a label of its own that CSS reveals at narrow widths.
    const { fixture } = formWithDimension('time');
    const row = host(fixture).querySelector('.level-row')!;
    const labels = Array.from(row.querySelectorAll('.level-field__label')).map((l) => l.textContent?.trim());
    expect(labels).toHaveLength(4); // Level, Display Name, Source, Time Function
    expect(labels[0]).toContain('Level');
    expect(labels[1]).toContain('Display Name');
    expect(labels[2]).toContain('Source');
    expect(labels[3]).toContain('Time Function');
  });

  it('keeps the column headings as a separate row CSS can hide', () => {
    const { fixture } = formWithDimension('time');
    const head = host(fixture).querySelector('.levels-grid__head');
    expect(head).not.toBeNull();
    // Five tracks for a time dimension (…+ Time Function + the remove slot), so a
    // heading always sits over the field it names in the wide layout.
    expect(head!.children).toHaveLength(5);
  });

  it('drops the Time Function column for a data dimension, in headings and rows alike', () => {
    const { fixture } = formWithDimension('data');
    const grid = host(fixture).querySelector('.levels-grid')!;
    expect(grid.classList.contains('levels-grid--time')).toBe(false);
    expect(host(fixture).querySelector('.levels-grid__head')!.children).toHaveLength(4);
    expect(host(fixture).querySelector('.level-field--timefn')).toBeNull();
  });

  it('flags a time dimension so the grid picks up its extra track', () => {
    const { fixture } = formWithDimension('time');
    expect(host(fixture).querySelector('.levels-grid')!.classList.contains('levels-grid--time')).toBe(true);
    expect(host(fixture).querySelector('.level-field--timefn')).not.toBeNull();
  });

  it('renders one row per level, each still editable', () => {
    const { fixture, component } = formWithDimension('time');
    component.addLevel(0, 0);
    component.addLevel(0, 0);
    render(fixture);

    const rows = host(fixture).querySelectorAll('.level-row');
    expect(rows).toHaveLength(3);
    // Every row keeps its own name input and time-function select…
    expect(host(fixture).querySelectorAll('.level-field--name input')).toHaveLength(3);
    expect(host(fixture).querySelectorAll('.level-field--timefn select')).toHaveLength(3);
    // …and a remove button, which only appears once there's more than one level.
    expect(host(fixture).querySelectorAll('.level-field--remove button')).toHaveLength(3);
  });

  it('hides the remove button on a lone level', () => {
    const { fixture } = formWithDimension();
    expect(host(fixture).querySelectorAll('.level-row')).toHaveLength(1);
    expect(host(fixture).querySelector('.level-field--remove button')).toBeNull();
  });
});
