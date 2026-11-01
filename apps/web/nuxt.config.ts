const apiUrl = process.env.API_URL ?? 'http://localhost:3001';

export default defineNuxtConfig({
  compatibilityDate: '2026-10-01',
  ssr: false,
  modules: ['@nuxt/ui', '@vueuse/nuxt'],
  css: ['~/assets/css/main.css'],
  devtools: { enabled: false },
  devServer: { port: 3000 },
  app: {
    head: {
      title: 'Kvitok',
      htmlAttrs: { lang: 'en' },
      // Edge to edge on phones (the layout pads the safe areas); on Android the keyboard shrinks the layout, keeping the composer in view.
      viewport: 'width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content',
      link: [
        { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' },
        { rel: 'icon', href: '/favicon.ico', sizes: '48x48' },
        { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' },
        // Installed on the home screen, the app gets web push on iOS.
        { rel: 'manifest', href: '/manifest.webmanifest' },
      ],
      meta: [
        { name: 'theme-color', content: '#F2551D' },
        { name: 'apple-mobile-web-app-capable', content: 'yes' },
        { name: 'apple-mobile-web-app-title', content: 'Kvitok' },
      ],
    },
  },
  // @nuxt/fonts (enabled by Nuxt UI) self-hosts Onest from --font-sans; the interface is also in Russian.
  // Onest comes from Google; the other providers are off, otherwise the build queries each of them
  // and an unreachable one (fontshare from a container) stalls it for minutes.
  fonts: {
    defaults: { weights: [400, 500, 600, 700], subsets: ['latin', 'latin-ext', 'cyrillic', 'cyrillic-ext'] },
    providers: { adobe: false, bunny: false, fontshare: false, fontsource: false, googleicons: false, npm: false },
  },
  routeRules: {
    // The API runs separately; proxy it so the session cookie is same-origin.
    '/api/**': { proxy: `${apiUrl}/api/**` },
  },
  typescript: { strict: true },
  vite: {
    optimizeDeps: { include: ['zod'] },
  },
});
