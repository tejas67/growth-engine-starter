import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Pure by design: no network, no database. Anything time-sensitive pins the
    // clock with vi.setSystemTime() to a mid-month date.
    globals: false,
    restoreMocks: true,
  },
});
