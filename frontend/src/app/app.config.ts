import { ApplicationConfig, provideBrowserGlobalErrorListeners, provideAppInitializer } from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { routes } from './app.routes';
import { loadAppConfig } from './core/app-config';
import { runPreflight } from './core/preflight';
import { authInterceptor } from './core/auth.interceptor';

export const appConfig: ApplicationConfig = {
  providers: [
    // Fetch /config.json (runtime API base URL) BEFORE the app bootstraps, so
    // every service resolves apiUrl() against the configured backend origin. The
    // setup preflight runs in the SAME initializer, strictly after it: the check
    // calls /api/preflight, which needs both the API base URL and the bearer token
    // this load supplies.
    //
    // It blocks bootstrap on purpose. The alternative — render, then gate — flashes
    // the Workbench and fires its page loads at an instance we have not confirmed,
    // so the user sees a dozen failing panels before the one explanation. The probe
    // is bounded server-side by SCO_PREFLIGHT_TIMEOUT_MS (5s default), and
    // runPreflight never rejects, so a failure still boots — into the gate.
    provideAppInitializer(async () => {
      await loadAppConfig();
      await runPreflight();
    }),
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes),
    provideHttpClient(withInterceptors([authInterceptor])),
    // ECharts self-registers via echarts.use() in dashboard/echarts-setup.ts, so the
    // renderer needs no application provider.
  ]
};
