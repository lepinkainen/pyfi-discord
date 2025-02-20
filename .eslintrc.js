// Base rules for all TypeScript files
const typeScriptRules = {
  "@typescript-eslint/no-unused-vars": [
    "error",
    {
      argsIgnorePattern: "^_", // Ignore variables that start with underscore
      varsIgnorePattern: "^_",
      caughtErrorsIgnorePattern: "^_",
    },
  ],
  // ... more rules
};

export default {
  parser: "@typescript-eslint/parser",
  extends: ["eslint:recommended", "plugin:@typescript-eslint/recommended"],
  rules: {
    ...typeScriptRules,
    // You can override or add environment-specific rules here
  },
  ignorePatterns: ["dist/", "node_modules/"],
};
