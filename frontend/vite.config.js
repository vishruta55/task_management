import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'https://task-management-1-3zk8.onrender.com',
      '/media': 'https://task-management-1-3zk8.onrender.com',
    },
  },
})