import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  envDir: '../..',
  plugins: [react(), tailwindcss()],
  server: {
    port: Number(process.env.FRONTEND_PORT || 5173),
    // Default to IPv4 loopback. Vite's own default binds ::1 only, which breaks
    // the `ssh -L 5173:localhost:5173` everyone types: that resolves to
    // 127.0.0.1, finds nothing listening, and looks like the dev server is down.
    // Passing --host through `npm run dev:frontend --` does not work either —
    // the flag is lost across the two npm layers and Vite reads the bare value
    // as its root directory. Set FRONTEND_HOST to override.
    host: process.env.FRONTEND_HOST || '127.0.0.1',
    // Opening a browser is pointless over SSH and just logs an xdg-open ENOENT.
    open: process.env.FRONTEND_OPEN === 'true',
    proxy: {
      '/movies': 'http://localhost:3000',
      '/theaters': 'http://localhost:3000',
      '/showings': 'http://localhost:3000',
      '/seats': 'http://localhost:3000',
      '/bookings': 'http://localhost:3000',
      '/study': 'http://localhost:3000',
      '/speech': 'http://localhost:3000',
      '/agent/config': 'http://localhost:3000',
      '/agent/ws': {
        target: 'ws://localhost:3000',
        ws: true,
      },
    },
  },
})
