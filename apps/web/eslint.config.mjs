import nextPlugin from "@next/eslint-plugin-next";
import rootConfig from "../../eslint.config.mjs";

// Regulile Next.js trăiesc aici, lângă aplicație, ca detectorul Next să le găsească la build.
export default [
  ...rootConfig,
  {
    plugins: { "@next/next": nextPlugin },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs["core-web-vitals"].rules,
    },
  },
];
