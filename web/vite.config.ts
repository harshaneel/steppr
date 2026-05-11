import { defineConfig } from "vite";

// Set base path so the app works at https://<user>.github.io/steppr/.
// Override with VITE_BASE=/ when serving from the root domain.
export default defineConfig({
  base: process.env.VITE_BASE ?? "/steppr/",
});
