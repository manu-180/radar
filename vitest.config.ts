import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
  resolve: {
    alias: {
      // Espeja el alias `@/*` del tsconfig para que los tests resuelvan los
      // mismos imports que el bundler de Next.
      "@": fileURLToPath(new URL(".", import.meta.url)),
      // `server-only` lanza al importarse si no se resuelve con la condición
      // `react-server` (que Next sí aplica). Bajo Vitest lo apuntamos a su
      // variante vacía para poder importar módulos marcados `server-only`.
      "server-only": fileURLToPath(
        new URL("./node_modules/server-only/empty.js", import.meta.url),
      ),
    },
  },
});
