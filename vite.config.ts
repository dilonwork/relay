import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const frontendPort = Number(env.FRONTEND_PORT) || 8090;
  const backendPort = Number(env.BACKEND_PORT) || 8890;
  return {
    plugins: [react()],
    server: {
      host: true,
      port: frontendPort,
      proxy: {
        '/api': {
          target: `http://localhost:${backendPort}`,
          // Do NOT rewrite the Host header (ticket 3b436bdd): the
          // backend uses the request Host as the project prompt
          // bundle's public base URL fallback (see
          // server/publicUrl.js), so the proxy must pass the
          // browser's Host through. With changeOrigin: true the
          // backend sees localhost:<backendPort> and the bundle
          // prints a localhost endpoint an external agent cannot
          // reach. PUBLIC_URL still wins when it is set.
          changeOrigin: false
        }
      }
    }
  };
})
