import { reactRouter } from "@react-router/dev/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    cloudflare({
      viteEnvironment: { name: "ssr" },
      // Smoke tests point this at a throwaway dir for a fresh local DB (no row deletes needed).
      ...(process.env.STOMP_PERSIST ? { persistState: { path: process.env.STOMP_PERSIST } } : {}),
    }),
    tailwindcss(),
    reactRouter(),
  ],
  resolve: {
    tsconfigPaths: true,
  },
});
