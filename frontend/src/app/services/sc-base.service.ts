import { Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class ScBaseService {
  constructor(private http: HttpClient) {}

  getAll<T>(basePath: string, resource: string, params?: Record<string, string>): Observable<T[]> {
    let httpParams = new HttpParams();
    if (params) Object.entries(params).forEach(([k, v]) => httpParams = httpParams.set(k, v));
    return this.http.get<T[]>(`${basePath}/${resource}`, { params: httpParams });
  }

  getById<T>(basePath: string, resource: string, id: string): Observable<T> {
    return this.http.get<T>(`${basePath}/${resource}/${id}`);
  }

//   create<T>(basePath: string, resource: string, body: Partial<T>): Observable<T> {
//     return this.http.post<T>(`${basePath}/${resource}`, body);
//   }

//   patch<T>(basePath: string, resource: string, id: string, body: Partial<T>): Observable<T> {
//     return this.http.patch<T>(`${basePath}/${resource}/${id}`, body);
//   }

//   put<T>(basePath: string, resource: string, id: string, body: T): Observable<T> {
//     return this.http.put<T>(`${basePath}/${resource}/${id}`, body);
//   }

//   delete(basePath: string, resource: string, id: string): Observable<void> {
//     return this.http.delete<void>(`${basePath}/${resource}/${id}`);
//   }

  post<T>(basePath: string, resource: string, body?: unknown): Observable<T> {
    return this.http.post<T>(`${basePath}/${resource}`, body ?? {});
  }
}
