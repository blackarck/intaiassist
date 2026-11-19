import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5173 },
  // Two pages: the app, and the small page Microsoft redirects the sign-in popup to.
  build: { rollupOptions: { input: { main: "index.html", redirect: "redirect.html" } } },
  test: { environment: "jsdom", globals: true },
});
