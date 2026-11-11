import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins: [react()],
  // Forward API calls to `npm run backend` during development.
  server: { proxy: { '/api': `http://127.0.0.1:${process.env.LEXEME_PORT ?? 3000}` } },
})
