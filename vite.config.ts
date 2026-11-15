import { defineConfig } from 'vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({ mode }) => ({
  plugins: [
    cloudflare({
      configPath: mode === 'deploy' ? 'wrangler.deploy.jsonc' : undefined,
    }),
    tailwindcss(),
  ],
}));
