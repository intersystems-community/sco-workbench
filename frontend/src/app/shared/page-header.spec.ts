import { TestBed } from '@angular/core/testing';
import { Component } from '@angular/core';
import { PageHeaderComponent } from './page-header';

@Component({ standalone: true, imports: [PageHeaderComponent],
  template: `<app-page-header [eyebrow]="e" [heading]="h" [level]="lvl" />` })
class Host { e = ''; h = 'My Title'; lvl: 1 | 2 = 1; }

describe('app-page-header', () => {
  it('renders an h1 by default with the heading text', () => {
    const f = TestBed.createComponent(Host); f.detectChanges();
    const el = f.nativeElement as HTMLElement;
    expect(el.querySelector('h1.ph__title')?.textContent?.trim()).toBe('My Title');
    expect(el.querySelector('h2.ph__title')).toBeNull();
  });
  it('renders an h2 when level=2', () => {
    const f = TestBed.createComponent(Host); f.componentInstance.lvl = 2; f.detectChanges();
    const el = f.nativeElement as HTMLElement;
    expect(el.querySelector('h2.ph__title')).not.toBeNull();
    expect(el.querySelector('h1.ph__title')).toBeNull();
  });
  it('hides the eyebrow when empty and shows it when set', () => {
    const f = TestBed.createComponent(Host);
    f.detectChanges();
    expect((f.nativeElement as HTMLElement).querySelector('.ph__eyebrow')).toBeNull();
    f.componentInstance.e = 'About';
    f.changeDetectorRef.markForCheck();
    f.detectChanges();
    expect((f.nativeElement as HTMLElement).querySelector('.ph__eyebrow')?.textContent?.trim()).toBe('About');
  });
});
