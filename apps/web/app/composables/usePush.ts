import type { PushConfigDto, PushSubscriptionDto } from '@kvitok/shared';

export type PushStep = 'secure' | 'homeScreen' | 'browser' | 'permission' | 'subscribed';
export type StepState = 'ok' | 'fail' | 'pending';

/** Web push on this device: what stands in the way, and subscribing or unsubscribing it. */
export function usePush() {
  const device = detectDevice(navigator.userAgent, navigator.maxTouchPoints);
  const secure = window.isSecureContext;
  const standalone = window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

  const config = ref<PushConfigDto | null>(null);
  const permission = ref<NotificationPermission | 'unsupported'>(supported ? Notification.permission : 'unsupported');
  const busy = ref(false);

  const current = computed<PushSubscriptionDto | null>(() => config.value?.subscriptions.find((s) => s.current) ?? null);

  /** Each check in order; the first failing one is what the user has to fix. */
  const steps = computed<Array<{ step: PushStep; state: StepState }>>(() => {
    const list: Array<{ step: PushStep; state: StepState }> = [{ step: 'secure', state: secure ? 'ok' : 'fail' }];
    if (device.os === 'ios') list.push({ step: 'homeScreen', state: standalone ? 'ok' : 'fail' });
    list.push({ step: 'browser', state: supported && !device.inApp ? 'ok' : 'fail' });
    list.push({ step: 'permission', state: permission.value === 'granted' ? 'ok' : permission.value === 'denied' ? 'fail' : 'pending' });
    list.push({ step: 'subscribed', state: current.value ? 'ok' : 'pending' });
    // Everything after the first problem cannot be checked yet.
    const blocked = list.findIndex((s) => s.state !== 'ok');
    return list.map((s, i) => (blocked !== -1 && i > blocked ? { ...s, state: 'pending' as const } : s));
  });
  const blockingStep = computed(() => steps.value.find((s) => s.state !== 'ok')?.step ?? null);
  const canEnable = computed(() => blockingStep.value === 'permission' ? permission.value === 'default' : blockingStep.value === 'subscribed');

  async function refresh(): Promise<void> {
    config.value = await api<PushConfigDto>('/notifications/push');
    if (supported) permission.value = Notification.permission;
  }

  /** Asks for permission first: Safari allows the prompt only right after a tap. */
  async function enable(): Promise<void> {
    if (!supported) return;
    busy.value = true;
    try {
      permission.value = await Notification.requestPermission();
      if (permission.value !== 'granted') return;
      const publicKey = (config.value ?? (await api<PushConfigDto>('/notifications/push'))).publicKey;
      const registration = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      const key = fromBase64Url(publicKey);
      let subscription = await registration.pushManager.getSubscription();
      // Subscribed with another server key (the installation's keys changed): such a subscription no longer works.
      if (subscription && !sameKey(subscription.options.applicationServerKey, key)) {
        await subscription.unsubscribe();
        subscription = null;
      }
      subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      await api('/notifications/push/subscriptions', { method: 'POST', body: subscription.toJSON() });
      await refresh();
    } finally {
      busy.value = false;
    }
  }

  /** Stops notifications on this device: in the browser and on the server. */
  async function disable(): Promise<void> {
    busy.value = true;
    try {
      const registration = supported ? await navigator.serviceWorker.getRegistration('/sw.js') : undefined;
      await (await registration?.pushManager.getSubscription())?.unsubscribe();
      if (current.value) await remove(current.value.id);
    } finally {
      busy.value = false;
    }
  }

  async function remove(id: string): Promise<void> {
    await api(`/notifications/push/subscriptions/${id}`, { method: 'DELETE' });
    await refresh();
  }

  /** The push service's answer, or null when it accepted the notification. */
  async function test(id: string): Promise<string | null> {
    const row = await api<PushSubscriptionDto>(`/notifications/push/subscriptions/${id}/test`, { method: 'POST' });
    await refresh();
    return row.lastError;
  }

  return { device, secure, standalone, supported, config, permission, busy, current, steps, blockingStep, canEnable, refresh, enable, disable, remove, test };
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const base64 = (value + '='.repeat((4 - (value.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function sameKey(current: ArrayBuffer | null, expected: Uint8Array): boolean {
  if (current === null) return false;
  const bytes = new Uint8Array(current);
  return bytes.length === expected.length && bytes.every((b, i) => b === expected[i]);
}
