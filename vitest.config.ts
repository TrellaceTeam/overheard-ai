import { defineConfig } from "vitest/config";

export default defineConfig({
  // Native tsconfig paths resolution, same as vite.config.ts.
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
