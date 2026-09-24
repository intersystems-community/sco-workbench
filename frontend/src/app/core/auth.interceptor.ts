import { HttpInterceptorFn } from '@angular/common/http';
import { apiUrl, authHeaders } from './api';

/**
 * Attach the workbench bearer token to outgoing backend API requests made
 * through Angular HttpClient (the SC data services, all built via
 * apiUrl('/api/...')). Scoped to our backend API on purpose: same-origin
 * non-API assets like introduction.ts's /use-cases/*.txt are served by the
 * frontend's own web server in a split deployment, so the token must not ride
 * along to a host outside its audience. `apiUrl('/api/')` is the backend API
 * prefix in BOTH topologies ('/api/' same-origin, 'https://host/api/' split),
 * so the startsWith test is correct in both. The assistant/session path uses
 * raw fetch() and is handled separately in assistant.service.ts — an HttpClient
 * interceptor never runs for fetch().
 */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const headers = authHeaders();
  const isBackendApi = req.url.startsWith(apiUrl('/api/'));
  return isBackendApi && headers['Authorization'] ? next(req.clone({ setHeaders: headers })) : next(req);
};
