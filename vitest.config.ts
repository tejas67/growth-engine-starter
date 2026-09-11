import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    environment: 'node',
    // Tests are pure/in-memory by design: no network, no database, no clock drift.
    // Any test that touches time pins it with vi.setSystemTime() mid-month.
    globals: false,
    restoreMocks: true,
  },
});
