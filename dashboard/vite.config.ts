import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [sveltekit()],
  server: {
    // The dashboard imports the engine's config/, db/ and src/ from the parent
    // directory, so Vite has to be allowed to read above its own root.
    fs: { allow: ['..'] },
  },
  ssr: {
    // Node-only database driver: never bundled, always required at runtime.
    external: ['pg', 'dotenv'],
  },
});
