/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        drive: {
          blue: "#1a73e8",
          "blue-hover": "#1967d2",
          "blue-light": "#e8f0fe",
          bg: "#f8f9fa",
          sidebar: "#f0f4f9",
          border: "#dadce0",
          text: "#202124",
          "text-secondary": "#5f6368",
          hover: "#e8eaed",
          selected: "#c2e7ff",
          "selected-border": "#1a73e8",
        },
      },
      fontFamily: {
        sans: [
          "Google Sans",
          "Roboto",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "sans-serif",
        ],
      },
    },
  },
  plugins: [],
};
