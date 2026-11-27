import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Navigation is tested through its browser build, as the development mock
    // runs it, so each import of React Native in it resolves to the web one.
    alias: [
      { find: /^react-native$/, replacement: "react-native-web" },
      // Its main entry is CommonJS, whose own require would load the native build.
      {
        find: /^react-native-safe-area-context$/,
        replacement: "react-native-safe-area-context/lib/module/index.js",
      },
    ],
    extensions: [".web.tsx", ".web.ts", ".tsx", ".ts", ".web.js", ".js", ".mjs", ".json"],
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "design-system/**/*.test.ts"],
    server: { deps: { inline: [/@react-navigation/, /react-native-safe-area-context/] } },
  },
});
