import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The phone web page (`dispatch serve` serves the built app/dist). `npm run dev` shows it with the
// sample data of fixtures.ts.
export default defineConfig({
  plugins: [react()],
});
