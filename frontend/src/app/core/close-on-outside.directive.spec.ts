import { Component } from '@angular/core';
import { TestBed, ComponentFixture } from '@angular/core/testing';
import { CloseOnOutsideDirective } from './close-on-outside.directive';

@Component({
  standalone: true,
  imports: [CloseOnOutsideDirective],
  template: `
    <details axCloseOnOutside>
      <summary>Pick</summary>
      <ul><li><label><input type="checkbox" /> A</label></li></ul>
    </details>
    <button id="outside">outside</button>
  `,
})
class HostComponent {}

describe('CloseOnOutsideDirective', () => {
  let fixture: ComponentFixture<HostComponent>;
  let details: HTMLDetailsElement;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [HostComponent] });
    fixture = TestBed.createComponent(HostComponent);
    document.body.appendChild(fixture.nativeElement);
    fixture.detectChanges();
    details = fixture.nativeElement.querySelector('details') as HTMLDetailsElement;
  });

  afterEach(() => {
    fixture.nativeElement.remove();
    TestBed.resetTestingModule();
  });

  it('closes an open <details> when a click lands outside it', () => {
    details.open = true;
    const outside = fixture.nativeElement.querySelector('#outside') as HTMLButtonElement;
    outside.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(details.open).toBe(false);
  });

  it('keeps an open <details> open when the click lands inside it (e.g. ticking a checkbox)', () => {
    details.open = true;
    const box = details.querySelector('input[type=checkbox]') as HTMLInputElement;
    box.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(details.open).toBe(true);
  });

  it('does nothing when the <details> is already closed', () => {
    details.open = false;
    document.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(details.open).toBe(false);
  });

  it('closes an open <details> on Escape', () => {
    details.open = true;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(details.open).toBe(false);
  });
});
