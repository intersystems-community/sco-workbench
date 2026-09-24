import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { ScBaseService } from './sc-base.service';
import { apiUrl } from '../core/api';

// Resolved per call (not at module load) so the runtime-configured API base is used.
const BASE = (): string => apiUrl('/api/scmodel/v1');

@Injectable({ providedIn: 'root' })
export class ScModelService {
  constructor(private base: ScBaseService) {}

  getObjects(): Observable<any[]> {
    return this.base.getAll<any>(BASE(), 'objects');
  }

  getObjectDetail(objectName: string): Observable<any> {
    return this.base.getById<any>(BASE(), 'objects', objectName);
  }

  addAttribute(objectName: string, body: unknown): Observable<any> {
    return this.base.post<any>(BASE(), `attributes/${encodeURIComponent(objectName)}`, body);
  }

  createObject(body: unknown): Observable<any> {
    return this.base.post<any>(BASE(), 'objects', body);
  }

  // updateCustomApi(body: unknown): Observable<any> {
  //   return this.base.post<any>(BASE(), 'updatecustomapi', body);
  // }
}
