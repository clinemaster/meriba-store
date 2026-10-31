import type { Config } from "tailwindcss";

/** A colour from the design tokens in globals.css (stored as "r g b" so opacity modifiers like bg-primary/10 work). */
const token = (name: string) => `rgb(var(--${name}) / <alpha-value>)`;

/** One meaning (success, warning…): strong for text and icons, soft for backgrounds, line for borders, ink for text on soft. */
const tone = (name: string) => ({ DEFAULT: token(name), soft: token(`${name}-soft`), line: token(`${name}-line`), ink: token(`${name}-ink`) });

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        /** Interactive: primary buttons, links, selection, focus. Kept under its old name so every brand-* class follows the tokens. */
        brand: { 50: token("action-50"), 100: token("action-100"), 200: token("action-200"), 600: token("action-600"), 700: token("action-700"), 800: token("action-800") },
        primary: { DEFAULT: token("primary"), light: token("primary-light"), dark: token("primary-dark") },
        secondary: tone("secondary"),
        success: tone("success"),
        warning: tone("warning"),
        danger: tone("danger"),
        info: tone("info"),
        neutral: tone("neutral"),
        refund: tone("refund"),
        canvas: token("canvas"),
        surface: token("surface"),
        ink: { DEFAULT: token("ink"), muted: token("ink-muted") },
        line: { DEFAULT: token("line"), strong: token("line-strong") },
      },
    },
  },
  plugins: [],
};

export default config;
