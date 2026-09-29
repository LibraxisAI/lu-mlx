import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  test: {
    globals: true,
    environment: 'node',
    // Node 22+ localStorage is a getter that returns undefined without
    // --localstorage-file. Persist/supabase then crash. See the setup file.
    setupFiles: ['src/test/vitest-localstorage.ts'],
    // dev-server/ kam mit ZB-7 dazu: der Dev-Server lag bis dahin in
    // vite.config.ts und war damit fuer vitest unsichtbar. Die Tests dort
    // haengen die ECHTEN Handler an einen echten node:http-Server.
    // .tsx kam mit den Sampling-Reglern dazu: Komponententests brauchen JSX,
    // und ohne die Endung war die Datei fuer vitest unsichtbar.
    include: [
      'src/**/__tests__/**/*.test.ts',
      'src/**/__tests__/**/*.test.tsx',
      'dev-server/**/__tests__/**/*.test.ts',
    ],
  },
})
