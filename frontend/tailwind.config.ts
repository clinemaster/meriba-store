import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: { 50: "#eef6f1", 100: "#d5eadd", 600: "#1f7a4d", 700: "#17623d", 800: "#124d30" },
      },
    },
  },
  plugins: [],
};

export default config;
