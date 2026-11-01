/**
 * Registers the service worker that shows web push notifications. A click on a notification
 * while the app is open arrives as a message, and the app opens the ticket without a reload.
 */
export default defineNuxtPlugin(() => {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  navigator.serviceWorker.register('/sw.js').catch(() => {
    // No notifications on this device; the notification settings page explains why.
  });
  navigator.serviceWorker.addEventListener('message', (event: MessageEvent<{ type?: string; path?: string }>) => {
    if (event.data?.type === 'kvitok:open' && typeof event.data.path === 'string' && event.data.path.startsWith('/')) {
      void navigateTo(event.data.path);
    }
  });
});
