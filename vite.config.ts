import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'Management',
        short_name: 'Management',
        description: 'Задачи и календарь с синхронизацией Google Calendar',
        lang: 'ru',
        start_url: '/',
        display: 'standalone',
        background_color: '#F7F5F0',
        theme_color: '#F7F5F0',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        navigateFallback: '/index.html',
        // Never serve the app shell for anything aimed at Supabase (auth
        // callbacks, REST, realtime) — those must always hit the network.
        // No runtimeCaching is registered, so Supabase fetches pass through.
        navigateFallbackDenylist: [/supabase\.co/, /supabase\.in/],
      },
    }),
  ],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: { port: 5173 },
  build: { outDir: 'dist', sourcemap: true },
})
