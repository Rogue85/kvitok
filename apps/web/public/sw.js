/* Kvitok service worker: shows web push notifications and opens the ticket on click. It caches nothing. */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  // Every push must show a notification: Safari revokes the subscription of a site that stays silent.
  event.waitUntil(
    self.registration.showNotification(data.title || 'Kvitok', {
      body: data.body || '',
      tag: data.tag,
      renotify: Boolean(data.tag),
      icon: '/icon-192.png',
      badge: '/badge-96.png',
      data: { url: data.url || '/' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/', self.location.origin);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const open = windows.find((client) => new URL(client.url).origin === url.origin);
      if (open) {
        // The app navigates itself, so an open tab keeps its state instead of reloading.
        open.postMessage({ type: 'kvitok:open', path: url.pathname + url.search });
        return open.focus();
      }
      return self.clients.openWindow(url.href);
    })(),
  );
});

/* The browser rotated the subscription: send the new one, the signed-in session's cookie goes along. */
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      const subscription =
        event.newSubscription ||
        (event.oldSubscription && (await self.registration.pushManager.subscribe(event.oldSubscription.options)));
      if (!subscription) return;
      await fetch('/api/notifications/push/subscriptions', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(subscription.toJSON()),
      });
    })(),
  );
});
