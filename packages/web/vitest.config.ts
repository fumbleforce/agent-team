import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Component tests for ui/ and patterns/ on happy-dom. Styles are not processed: tests assert behaviour and roles, not pixels.
export default defineConfig({
  plugins: [react()],
  test: { environment: 'happy-dom', include: ['src/**/*.test.tsx'], setupFiles: ['test/setup.ts'], css: false, restoreMocks: true },
});
