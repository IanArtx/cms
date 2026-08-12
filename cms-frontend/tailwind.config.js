/** @type {import('tailwindcss').Config} */
module.exports = {
  // 'media' = the app automatically follows the operating system's
  // light/dark setting (prefers-color-scheme) — no in-app toggle,
  // no stored preference, it just matches the device. This is a
  // build-time config switch, not something end users interact with.
  darkMode: 'media',
  content: [
    "./src/**/*.{js,jsx,ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        primary: {
          50:  '#eff6ff',
          100: '#dbeafe',
          200: '#bfdbfe',
          300: '#93c5fd',
          400: '#60a5fa',
          500: '#3b82f6',
          600: '#2563eb',
          700: '#1d4ed8',
          800: '#1e40af',
          900: '#1e3a5f',
        },
        // Accent used alongside `primary` to build the gradient banners/
        // tiles (primary -> accent). Sits next to blue on the wheel so
        // gradients read as "one brand, richer" rather than clashing.
        accent: {
          50:  '#eef2ff',
          100: '#e0e7ff',
          200: '#c7d2fe',
          300: '#a5b4fc',
          400: '#818cf8',
          500: '#6366f1',
          600: '#4f46e5',
          700: '#4338ca',
          800: '#3730a3',
          900: '#312e81',
        },
      },
      // Reusable gradient backgrounds — swap a single class instead of
      // repeating a `bg-gradient-to-r from-... to-...` string on every
      // banner/tile across ~40 pages.
      backgroundImage: {
        'brand-gradient': 'linear-gradient(135deg, #1d4ed8 0%, #4f46e5 55%, #0891b2 100%)',
        'brand-gradient-soft': 'linear-gradient(135deg, #eff6ff 0%, #eef2ff 100%)',
        'brand-gradient-soft-dark': 'linear-gradient(135deg, #1e293b 0%, #1e1b4b 100%)',
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui'],
      },
    },
  },
  plugins: [
    require('@tailwindcss/forms'),
  ],
}