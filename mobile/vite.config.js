import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { checkFirmwareBuild } from '../app/scripts/check-firmware-build.js';

const app = fileURLToPath(new URL('../app/', import.meta.url));
const entry = fileURLToPath(new URL('./src/main.js', import.meta.url));
export default defineConfig(({ mode }) => {
  if (mode === 'emulator') checkFirmwareBuild();
  return {
    root: app,
    define: { 'import.meta.env.VITE_CARRY_DEMO': JSON.stringify(mode === 'emulator' ? 'firmware' : '') },
    plugins: [{
      name: 'carry-native-entry',
      transformIndexHtml: {
        order: 'pre',
        handler(html) { return html.replace('src="/src/main.js"', `src="/@fs${entry}"`); },
      },
    }],
    build: {
      outDir: fileURLToPath(new URL('./www/', import.meta.url)),
      emptyOutDir: true,
      rollupOptions: { input: `${app}index.html` },
    },
  };
});
