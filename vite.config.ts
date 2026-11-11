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
          changeOrigin: true
        }
      }
    }
  };
})
