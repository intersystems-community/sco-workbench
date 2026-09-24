import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { PageHeaderComponent } from '../shared/page-header';

interface UcModule {
  label: string;
  soon?: boolean;
}

interface UseCase {
  id: string;
  icon: string;
  title: string;
  modules: UcModule[];
}

const USE_CASES: UseCase[] = [
  { id: 'uc-unify',    icon: '🔗', title: 'Unify Supply Chain Data',    modules: [{ label: 'Data Model' }, { label: 'Data Integration' }, { label: 'Dashboard' }] },
  { id: 'uc-risks',   icon: '🚨', title: 'Identify Supply Chain Risks', modules: [{ label: 'Business KPI' }, { label: 'Analytics Cube' }, { label: 'Dashboard' }] },
  { id: 'uc-actions', icon: '💡', title: 'Drive Actionable Decisions',  modules: [{ label: 'Business KPI' }, { label: 'Business Processes', soon: true }, { label: 'Dashboard' }] },
];


/**
 * "Introduction" — the first page under Getting Started: what SCO and this workbench
 * are, what to have in place before starting, and the use cases the platform is for.
 * Its CSS keeps the `gs-` (getting-started) class prefix it was written with; the
 * classes are component-scoped, so the names are internal to this page.
 */
@Component({
  selector: 'app-introduction',
  standalone: true,
  imports: [CommonModule, PageHeaderComponent],
  templateUrl: './introduction.html',
  styleUrl: './introduction.css',
})
export class IntroductionComponent implements OnInit {
  useCases = USE_CASES;

  selectedUseCase: UseCase | null = null;
  ucTexts: Record<string, { overview: string; workbench: string }> = {};

  constructor(private http: HttpClient) {}

  ngOnInit(): void {
    for (const uc of USE_CASES) {
      this.ucTexts[uc.id] = { overview: '', workbench: '' };
      const base = `/use-cases/${uc.id}`;
      this.http.get(`${base}-overview.txt`, { responseType: 'text' })
        .subscribe({ next: t => { this.ucTexts[uc.id].overview = t; }, error: () => {} });
      this.http.get(`${base}-workbench.txt`, { responseType: 'text' })
        .subscribe({ next: t => { this.ucTexts[uc.id].workbench = t; }, error: () => {} });
    }
  }

  hasSoonModule(uc: UseCase): boolean { return uc.modules.some(m => m.soon); }

  openUseCase(uc: UseCase): void { this.selectedUseCase = uc; }

  closeUseCase(): void { this.selectedUseCase = null; }

}
