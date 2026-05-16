import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
  resolve: {
    // Espeja el alias `@/*` del tsconfig para que los tests resuelvan los
    // mismos imports que el bundler de Next.
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
});
