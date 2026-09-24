// frontend/src/app/resources/resources.guided.spec.ts
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import type { GuidedFormController, SetFieldResult } from '../core/workbench-bridge.service';
import { ResourcesComponent } from './resources';

/**
 * Guided-mode field routing for the Data Model page (the `ui_set_field` path).
 *
 * These drive the component class directly (no TestBed): the behaviour under test
 * is the field-path routing in `guidedSetField`, reached through the same
 * `GuidedFormController.setField` the assistant bridge calls. We capture the
 * controller the component registers on init, so the tests exercise the real
 * code path rather than a private method by name.
 *
 * Covers the guided-form fixes:
 *  - set_field FAILS when no form is open (SC-2681) — the assistant must reopen
 *    explicitly via ui_open_form, not have set_field silently reopen a blank form.
 *  - a bare `name` on the OBJECT form FAILS with a redirect to `objectName`
 *    (the "object called abc became an attribute named abc" mis-mapping).
 *  - correct paths still land: `objectName`, `description`, `attributes.N.*`,
 *    and the attribute form's own `name`.
 *  - setting `attributes.N.*` at a fresh index auto-creates the row (no user click).
 */

interface FakeObject { objectName: string; className: string; description?: string; isCustom?: boolean }

function makeComponent(objects: FakeObject[] = []) {
  let controller: GuidedFormController | null = null;
  const noop = () => undefined;
  const bridge = {
    register: (c: GuidedFormController) => { controller = c; },
    unregister: noop,
  };
  const scModel = {
    getObjects: () => of(objects),
    // Detail fetch used by selectObject — echo a minimal detail with no attributes.
    getObjectDetail: (name: string) => of({ objectName: name, className: `SC.Data.${name}`, attributes: [] }),
  };
  const component = new ResourcesComponent(
    scModel as never,                                       // ScModelService
    { markForCheck: noop, detectChanges: noop } as never,   // ChangeDetectorRef
    bridge as never,                                        // WorkbenchBridgeService
    { success: noop, error: noop } as never,                // ToastService
    { getCounts: () => of({}) } as never,                   // DataBrowserService
  );
  component.ngOnInit(); // registers the guided controller + loads objects
  if (!controller) throw new Error('guided controller was not registered');
  const c = controller as GuidedFormController;
  const setField = (path: string, value: unknown): SetFieldResult =>
    c.setField(path, value) as SetFieldResult;
  const openEntity = (name: string, opts?: { formKind?: string; mode?: 'view' | 'edit' }): Promise<SetFieldResult> =>
    c.openEntity!(name, opts);
  return { component, setField, openEntity };
}

describe('guided set_field — no form open', () => {
  it('FAILS (does not reopen) when neither create form is open', () => {
    const { setField } = makeComponent();
    const res = setField('objectName', 'abc');
    expect(res.applied).toBe(false);
    expect(res.detail).toMatch(/no data model form is open/i);
  });

  it('FAILS for an attribute-form field when no form is open', () => {
    const { setField } = makeComponent();
    expect(setField('name', 'sku').applied).toBe(false);
  });
});

describe('guided set_field — object form field mapping', () => {
  it('sets objectName on the open object form', () => {
    const { component, setField } = makeComponent();
    component.openObjModal();
    const res = setField('objectName', 'abc');
    expect(res.applied).toBe(true);
    expect(component.objForm.objectName).toBe('abc');
  });

  it('sets the object description on the open object form', () => {
    const { component, setField } = makeComponent();
    component.openObjModal();
    expect(setField('description', 'a test object').applied).toBe(true);
    expect(component.objForm.description).toBe('a test object');
  });

  it('REJECTS a bare "name" on the object form and points at objectName (mis-mapping guard)', () => {
    const { component, setField } = makeComponent();
    component.openObjModal();
    const res = setField('name', 'abc');
    expect(res.applied).toBe(false);
    expect(res.detail).toMatch(/objectName/);
    // The value must NOT have leaked into the first attribute row.
    expect(component.objForm.objectName).toBe('');
    expect(component.objAttrs[0]!.name).toBe('');
  });

  it('REJECTS a bare "dataType" on the object form and points at attributes.N.dataType', () => {
    const { component, setField } = makeComponent();
    component.openObjModal();
    const res = setField('dataType', 'String');
    expect(res.applied).toBe(false);
    expect(res.detail).toMatch(/attributes\.N\.dataType/);
  });
});

describe('guided set_field — attribute rows auto-create (no user click)', () => {
  it('creates rows on demand when setting attributes.N.* at a fresh index', () => {
    const { component, setField } = makeComponent();
    component.openObjModal(); // starts with exactly one empty row
    expect(component.objAttrs.length).toBe(1);

    // Fill five attributes' names in sequence — rows 1..4 must be auto-created.
    for (let i = 0; i < 5; i++) {
      expect(setField(`attributes.${i}.name`, `attr${i}`).applied).toBe(true);
    }
    expect(component.objAttrs.length).toBe(5);
    expect(component.objAttrs.map((a) => a.name)).toEqual(['attr0', 'attr1', 'attr2', 'attr3', 'attr4']);
  });

  it('validates attribute dataType against the dropdown options', () => {
    const { component, setField } = makeComponent();
    component.openObjModal();
    expect(setField('attributes.0.dataType', 'String').applied).toBe(true);
    const bad = setField('attributes.0.dataType', 'NotAType');
    expect(bad.applied).toBe(false);
    expect(bad.detail).toMatch(/not a valid data type/i);
  });
});

describe('guided set_field — attribute form', () => {
  it('routes bare name/dataType to the attribute form when it is open', () => {
    const { component, setField } = makeComponent();
    component.openAttrModal();
    expect(setField('name', 'sku').applied).toBe(true);
    expect(component.attrForm.name).toBe('sku');
  });
});

describe('guided open_entity — select an object by name', () => {
  const OBJECTS = [
    { objectName: 'Customer', className: 'SC.Data.Customer' },
    { objectName: 'Employee', className: 'SC.Data.Employee' },
  ];

  it('selects the named object and opens its attribute form (formKind: attribute)', async () => {
    const { component, openEntity } = makeComponent(OBJECTS);
    const res = await openEntity('Employee', { formKind: 'attribute' });
    expect(res.applied).toBe(true);
    expect(component.selectedObject?.objectName).toBe('Employee');
    expect(component.attrModalOpen).toBe(true);
  });

  it('selects the named object without opening a form when no formKind is given', async () => {
    const { component, openEntity } = makeComponent(OBJECTS);
    const res = await openEntity('Customer');
    expect(res.applied).toBe(true);
    expect(component.selectedObject?.objectName).toBe('Customer');
    expect(component.attrModalOpen).toBe(false);
    expect(component.objModalOpen).toBe(false);
  });

  it('FAILS with the list of real objects when the named object does not exist', async () => {
    const { openEntity } = makeComponent(OBJECTS);
    const res = await openEntity('Nope');
    expect(res.applied).toBe(false);
    expect(res.detail).toMatch(/no object named "Nope"/i);
    expect(res.detail).toMatch(/Customer/);
    expect(res.detail).toMatch(/Employee/);
  });

  it('uses the shared .page--full shell', () => {
    TestBed.configureTestingModule({
      imports: [ResourcesComponent],
      providers: [
        { provide: 'ScModelService', useValue: { getObjects: () => of([]) } },
        { provide: 'DataBrowserService', useValue: { getCounts: () => of({}) } },
      ],
    });
    const fixture = TestBed.createComponent(ResourcesComponent);
    expect((fixture.nativeElement as HTMLElement).querySelector('.resources-page.page--full')).not.toBeNull();
  });
});

/**
 * Refresh must come back to the object the user had open (the `?item=` deep link the
 * shell mirrors into the URL), and a link to an object that has since gone must fall
 * back to the overview silently.
 */
describe('data-model `?item=` deep link', () => {
  function withController(objects: FakeObject[]) {
    let controller: GuidedFormController | null = null;
    const noop = () => undefined;
    const scModel = {
      getObjects: () => of(objects),
      getObjectDetail: (name: string) => of({ objectName: name, className: `SC.Data.${name}`, attributes: [] }),
    };
    const component = new ResourcesComponent(
      scModel as never,
      { markForCheck: noop, detectChanges: noop } as never,
      { register: (c: GuidedFormController) => { controller = c; }, unregister: noop } as never,
      { success: noop, error: noop } as never,
      { getCounts: () => of({}) } as never,
    );
    component.ngOnInit();
    if (!controller) throw new Error('guided controller was not registered');
    return { component, controller: controller as GuidedFormController };
  }

  it('reports the selected object, and nothing on the overview', () => {
    const { component, controller } = withController([{ objectName: 'Supplier', className: 'SC.Data.Supplier' }]);
    expect(controller.currentItem!()).toBeNull();

    component.selectObject({ objectName: 'Supplier', className: 'SC.Data.Supplier', description: '', isCustom: false });

    expect(controller.currentItem!()).toBe('Supplier');
  });

  it('re-selects the object the token names', async () => {
    const { component, controller } = withController([{ objectName: 'Supplier', className: 'SC.Data.Supplier' }]);

    expect(await controller.restoreItem!('Supplier')).toBe(true);

    expect(component.selectedObject?.objectName).toBe('Supplier');
  });

  it('reports false for an object that no longer exists, leaving the overview on screen', async () => {
    const { component, controller } = withController([{ objectName: 'Supplier', className: 'SC.Data.Supplier' }]);

    expect(await controller.restoreItem!('Deleted')).toBe(false);

    expect(component.selectedObject).toBeNull();
  });
});
