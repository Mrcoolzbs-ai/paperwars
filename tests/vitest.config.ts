import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['**/*.test.ts'],
    environment: 'node',
    clearMocks: true,
    // PostgreSQL integration files share a database and the Worker claims from a global queue.
    fileParallelism: false,
  },
});
