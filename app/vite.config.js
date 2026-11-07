import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { checkFirmwareBuild } from './scripts/check-firmware-build.js';

export default defineConfig({
  plugins: [{
    name: 'firmware-source-check',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url?.split('?')[0] === '/firmware/manifest.json') {
          try { checkFirmwareBuild(); }
          catch (error) {
            response.statusCode = 409;
            response.setHeader('Content-Type', 'application/json');
            response.end(JSON.stringify({ error: `Firmware simulation is stale: ${error.message} Run npm run firmware:build, then reload.` }));
            return;
          }
        }
        next();
      });
    },
  }],
  build: {
    rollupOptions: {
      input: {
        app: fileURLToPath(new URL('./index.html', import.meta.url)),
        emulator: fileURLToPath(new URL('./emulator.html', import.meta.url)),
        simulation: fileURLToPath(new URL('./simulation.html', import.meta.url)),
      },
    },
  },
});
