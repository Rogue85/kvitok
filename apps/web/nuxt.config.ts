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
      link: [
        { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' },
        { rel: 'icon', href: '/favicon.ico', sizes: '48x48' },
        { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' },
      ],
    },
  },
  // @nuxt/fonts (enabled by Nuxt UI) self-hosts Onest from --font-sans; the interface is also in Russian.
  fonts: {
    defaults: { weights: [400, 500, 600, 700], subsets: ['latin', 'latin-ext', 'cyrillic', 'cyrillic-ext'] },
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
