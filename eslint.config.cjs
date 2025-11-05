const tsdoc = require("eslint-plugin-tsdoc");

module.exports = [
  {
    files: ["**/*.ts", "**/*.tsx"], // Target TypeScript files
    plugins: {
      tsdoc, // Add TSDoc plugin
    },
    languageOptions: {
      parser: require("@typescript-eslint/parser"), // Parse TypeScript
    },
    rules: {
      "tsdoc/syntax": "warn", // Enforce TSDoc syntax
    },
  },
];
