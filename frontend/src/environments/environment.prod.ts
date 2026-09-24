/**
 * Production environment (used for `ng build`, swapped in via angular.json
 * fileReplacements).
 *
 * Defaults to '' (same origin) because the production single Docker image has
 * the backend serve the built Angular app and answer /api on the same origin —
 * no cross-origin base URL is needed. If you split the deployment so the
 * frontend is served from a different origin than the backend, set this to the
 * backend's public origin (e.g. 'https://api.example.com') and enable CORS on
 * the backend for the frontend's origin.
 */
export const environment = {
  production: true,
  apiBaseUrl: '',
};
