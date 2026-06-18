/** @type {import('tailwindcss').Config} */
// Caper CostWise — design tokens. Every color pair below was verified ≥ WCAG AA
// (see redesign/README.md → "Accessibility verification").
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        // Surfaces (warm, on-brand)
        bg: '#FBF8F3',
        surface: '#FFFFFF',
        'surface-2': '#F4F1EA',
        line: '#E4E0D8',
        'line-strong': '#D6D1C6',
        // Text — all pass AA on white/warm bg
        ink: '#13231D', // 16.3:1
        'ink-2': '#3A4843', // 9.6:1
        muted: '#5B6B64', // 5.6:1
        // Brand green (Instacart/Caper, AA-tuned)
        brand: {
          50: '#E6F4EC',
          100: '#CDE9D9',
          200: '#9FD3B6',
          300: '#5FBF86',
          400: '#43B02A', // bright brand — fills/illustration ONLY (fails as text)
          500: '#13935F',
          600: '#0E7A56', // 5.33:1 — hover / large text
          700: '#0B6E4F', // 6.25:1 — PRIMARY buttons & text on white
          800: '#055C3B',
          900: '#04372A', // 13.25:1 — chrome / headlines
        },
        // Carrot accent
        carrot: {
          50: '#FFF4E0',
          100: '#FFE6C2',
          400: '#F36D00', // bright carrot — fills/illustration ONLY
          600: '#B4530A', // 5.0:1 — accessible accent text/links
          700: '#9A4A00',
        },
        // Semantic status — fg verified AA on matching tint
        success: { fg: '#0E7A56', bg: '#E6F4EC' },
        warning: { fg: '#9A5B00', bg: '#FFF4E0' },
        danger: { fg: '#B42318', bg: '#FDE7E6' },
        info: { fg: '#175CD3', bg: '#EAF1FE' },
        ap: { fg: '#6941C6', bg: '#F0EBFB' }, // "Sent to AP" — distinct from Paid
      },
      borderRadius: {
        sm: '8px', md: '12px', lg: '16px', xl: '20px', '2xl': '28px',
      },
      boxShadow: {
        card: '0 1px 2px rgba(16,40,32,.04), 0 2px 8px rgba(16,40,32,.06)',
        'card-hover': '0 4px 16px rgba(16,40,32,.10)',
        sheet: '0 -8px 40px rgba(16,40,32,.18)',
        pop: '0 8px 32px rgba(16,40,32,.16)',
        focus: '0 0 0 3px rgba(14,122,86,.35)',
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'Helvetica', 'Arial', 'sans-serif'],
      },
      fontSize: {
        // type scale
        '2xs': ['11px', { lineHeight: '14px' }],
        xs: ['12px', { lineHeight: '16px' }],
        sm: ['13px', { lineHeight: '18px' }],
        base: ['16px', { lineHeight: '24px' }],
        lg: ['18px', { lineHeight: '26px' }],
        xl: ['20px', { lineHeight: '28px' }],
        '2xl': ['24px', { lineHeight: '30px' }],
        '3xl': ['30px', { lineHeight: '36px' }],
        '4xl': ['36px', { lineHeight: '42px' }],
      },
      spacing: { 18: '4.5rem', 22: '5.5rem' },
      maxWidth: { phone: '420px', content: '1200px' },
      keyframes: {
        'sheet-up': { '0%': { transform: 'translateY(100%)' }, '100%': { transform: 'translateY(0)' } },
        'fade-in': { '0%': { opacity: '0' }, '100%': { opacity: '1' } },
        pulse: { '0%,100%': { opacity: '1' }, '50%': { opacity: '.5' } },
      },
      animation: {
        'sheet-up': 'sheet-up .28s cubic-bezier(.2,.8,.2,1)',
        'fade-in': 'fade-in .2s ease',
      },
    },
  },
  plugins: [],
}
