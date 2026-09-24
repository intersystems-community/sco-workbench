import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { IntroductionComponent } from './introduction';

describe('IntroductionComponent', () => {
  let fixture: ReturnType<typeof TestBed.createComponent<IntroductionComponent>>;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    fixture = TestBed.createComponent(IntroductionComponent);
    fixture.detectChanges();
  });

  it('renders three app-page-header section headers and no bespoke idiom', () => {
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelectorAll('app-page-header').length).toBe(3);
    expect(el.querySelector('.section-eyebrow')).toBeNull();
    expect(el.querySelector('.section-title')).toBeNull();
  });
});
