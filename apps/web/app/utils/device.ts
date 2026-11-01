export type DeviceOs = 'ios' | 'android' | 'macos' | 'windows' | 'linux' | 'other';
export type DeviceBrowser = 'safari' | 'chrome' | 'firefox' | 'edge' | 'yandex' | 'samsung' | 'other';

export interface Device {
  os: DeviceOs;
  browser: DeviceBrowser;
  /** A browser built into another app (Telegram, Instagram…): no web push there. */
  inApp: boolean;
}

/** Recognizes the platform from a user agent; an iPad asking for the desktop site reports macOS with touch. */
export function detectDevice(userAgent: string, maxTouchPoints = 0): Device {
  const ua = userAgent;
  let os: DeviceOs = 'other';
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1)) os = 'ios';
  else if (/Android/.test(ua)) os = 'android';
  else if (/Macintosh|Mac OS X/.test(ua)) os = 'macos';
  else if (/Windows/.test(ua)) os = 'windows';
  else if (/Linux|X11|CrOS/.test(ua)) os = 'linux';

  let browser: DeviceBrowser = 'other';
  if (/YaBrowser/.test(ua)) browser = 'yandex';
  else if (/SamsungBrowser/.test(ua)) browser = 'samsung';
  else if (/Edg(e|A|iOS)?\//.test(ua)) browser = 'edge';
  else if (/Firefox|FxiOS/.test(ua)) browser = 'firefox';
  else if (/Chrome|CriOS|Chromium/.test(ua)) browser = 'chrome';
  else if (/Safari/.test(ua)) browser = 'safari';

  const inApp = /Telegram|Instagram|FBAN|FBAV|VKClient|; wv\)/.test(ua);
  return { os, browser, inApp };
}

const OS_NAMES: Record<DeviceOs, string> = { ios: 'iOS', android: 'Android', macos: 'macOS', windows: 'Windows', linux: 'Linux', other: '' };
const BROWSER_NAMES: Record<DeviceBrowser, string> = {
  safari: 'Safari',
  chrome: 'Chrome',
  firefox: 'Firefox',
  edge: 'Edge',
  yandex: 'Yandex Browser',
  samsung: 'Samsung Internet',
  other: '',
};

/** "Chrome · macOS" for a list of devices; null when nothing is recognized. */
export function describeDevice(userAgent: string | null): string | null {
  if (!userAgent) return null;
  const device = detectDevice(userAgent);
  const parts = [BROWSER_NAMES[device.browser], OS_NAMES[device.os]].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : null;
}
