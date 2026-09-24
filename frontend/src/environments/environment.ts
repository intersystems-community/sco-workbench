/**
 * Development environment.
 *
 * `apiBaseUrl` is the origin (scheme://host:port) the frontend prepends to every
 * backend API call (`/api/...`, `/healthz`). An EMPTY string means "same origin"
 * — the app calls relative paths, which the Angular dev server proxies to the
 * backend (see proxy.conf.js) and, in the single-image deployment, the backend
 * serves and answers directly. This is the default because frontend and backend
 * ship together today.
 *
 * To deploy the frontend separately from the backend, set this to the backend's
 * public origin (e.g. 'https://api.example.com') here or in environment.prod.ts.
 * The backend must then allow that frontend origin via CORS.
 */
export const environment = {
  production: false,
  apiBaseUrl: '',
};
