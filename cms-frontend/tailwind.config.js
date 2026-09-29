/** @type {import('tailwindcss').Config} */
// ============================================================
// TAILWIND CONFIG — v1.71.0 "Harbour" design
//
// darkMode: 'class' (was 'media' until v1.70). Each person now picks
// Light, Dark or "Same as my device" from the top bar; ThemeContext.js
// puts the `dark` class on <html> when dark is in effect. "Same as my
// device" still follows the operating system exactly like before.
//
// The colours below are FIXED — they are no longer read from Settings.
// Company colours (Settings > Company) are used only on generated
// documents and email templates (see exportUtils.setBranding).
// ============================================================
module.exports = {
  darkMode: 'class',
  content: [
    "./src/**/*.{js,jsx,ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Main action colour (buttons, links, active tab, selected item).
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
          900: '#0b1f3a', // Harbour navy (sidebar, deep banners)
        },
        // Second brand colour — teal. Used at the end of the page
        // header gradient, for the "company" mark and for highlights.
        accent: {
          50:  '#f0fdfa',
          100: '#ccfbf1',
          200: '#99f6e4',
          300: '#5eead4',
          400: '#2dd4bf',
          500: '#14b8a6',
          600: '#0d9488',
          700: '#0f766e',
          800: '#115e59',
          900: '#134e4a',
        },
        navy: {
          DEFAULT: '#0b1f3a',
          700: '#132c4f',
          600: '#24406a',
          dark: '#08111f',
        },
      },
      backgroundImage: {
        // The page header band: blue -> deep blue -> teal.
        'brand-gradient': 'linear-gradient(100deg, #1d4ed8 0%, #1e40af 45%, #0f766e 100%)',
        'brand-gradient-dark': 'linear-gradient(100deg, #1e3a8a 0%, #172554 50%, #134e4a 100%)',
        'brand-gradient-soft': 'linear-gradient(135deg, #eff6ff 0%, #f0fdfa 100%)',
        'brand-gradient-soft-dark': 'linear-gradient(135deg, #111a2e 0%, #10262a 100%)',
      },
      fontFamily: {
        sans: ['"Plus Jakarta Sans"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      boxShadow: {
        card: '0 1px 2px rgba(15, 23, 42, 0.04), 0 1px 3px rgba(15, 23, 42, 0.06)',
        pop: '0 12px 32px rgba(15, 23, 42, 0.16)',
      },
    },
  },
  plugins: [
    require('@tailwindcss/forms'),
  ],
}
