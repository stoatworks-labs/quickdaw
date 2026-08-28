/**
 * Registers the service worker.
 *
 * In a module rather than an inline script because the CSP in `public/_headers`
 * is `script-src 'self'`, which blocks inline script outright — and the failure
 * would be silent: the page renders, nothing registers, and the app is simply
 * never installable.
 *
 * Deferred to `load`. A service worker install fetches the shell, and doing
 * that while the page is still fetching its own assets makes first paint slower
 * for a benefit that only matters on the second visit.
 */
export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;

  // A worker registered from a dev server would cache the dev shell and then
  // answer for it after the tab moves on.
  if (import.meta.env.DEV) return;

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((error: unknown) => {
      console.warn('offline support unavailable:', error);
    });
  });
}
