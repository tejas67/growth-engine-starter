import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/**
 * The dashboard is its own npm package but it reads the ENGINE's code, not a copy of
 * it. These aliases point at the parent repo so there is exactly one config module,
 * one repository layer and one set of pure approval transitions in the system.
 *
 * @type {import('@sveltejs/kit').Config}
 */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter(),
    alias: {
      $config: '../config/index.ts',
      $local: '../config/local.ts',
      $db: '../db/client.ts',
      $core: '../src',
      '$core/*': '../src/*',
    },
  },
};

export default config;
