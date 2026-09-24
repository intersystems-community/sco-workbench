// Angular dev-server proxy.
//
// The browser talks ONLY to our Node backend (default :3000). The backend:
//   - serves the agent chat API (/api/agent, /api/sessions) itself, and
//   - reverse-proxies every other /api/* call to the user-managed IRIS,
//     injecting Basic auth and the /api/{namespace} rewrite server-side.
//
// So this dev proxy no longer needs the IRIS host, credentials, or any path
// rewrite — it just forwards to the backend, which owns all of that. Override
// the backend location with BACKEND_ORIGIN when it runs on another port/host.
const BACKEND_ORIGIN = process.env.BACKEND_ORIGIN || 'http://localhost:3000';

module.exports = [
  {
    context: ['/api', '/healthz', '/config.json'],
    target: BACKEND_ORIGIN,
    secure: false,
    changeOrigin: true,
  },
];
