/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // 全局背景颜色
        'primary-bg': 'rgb(var(--color-bg-primary) / <alpha-value>)',
        'secondary-bg': 'rgb(var(--color-bg-secondary) / <alpha-value>)',
        'tertiary-bg': 'rgb(var(--color-bg-tertiary) / <alpha-value>)',

        // 文字颜色
        'text-primary': 'rgb(var(--color-text-primary) / <alpha-value>)',
        'text-secondary': 'rgb(var(--color-text-secondary) / <alpha-value>)',
        'text-tertiary': 'rgb(var(--color-text-tertiary) / <alpha-value>)',

        // 边框颜色
        'border-subtle': 'rgb(var(--color-border-subtle) / <alpha-value>)',

        // 便签颜色 (用于 Tailwind JIT 扫描和语义化)
        'note-white': {
          light: 'var(--note-white-light)',
          dark: 'var(--note-white-dark)',
        },
        'note-yellow': {
          light: 'var(--note-yellow-light)',
          dark: 'var(--note-yellow-dark)',
        },
        'note-green': {
          light: 'var(--note-green-light)',
          dark: 'var(--note-green-dark)',
        },
        'note-teal': {
          light: 'var(--note-teal-light)',
          dark: 'var(--note-teal-dark)',
        },
        'note-blue': {
          light: 'var(--note-blue-light)',
          dark: 'var(--note-blue-dark)',
        },
        'note-purple': {
          light: 'var(--note-purple-light)',
          dark: 'var(--note-purple-dark)',
        },
        'note-pink': {
          light: 'var(--note-pink-light)',
          dark: 'var(--note-pink-dark)',
        },
        'note-orange': {
          light: 'var(--note-orange-light)',
          dark: 'var(--note-orange-dark)',
        },
        'note-red': {
          light: 'var(--note-red-light)',
          dark: 'var(--note-red-dark)',
        },
        'note-slate': {
          light: 'var(--note-slate-light)',
          dark: 'var(--note-slate-dark)',
        },
        'note-lime': {
          light: 'var(--note-lime-light)',
          dark: 'var(--note-lime-dark)',
        },
        'note-cyan': {
          light: 'var(--note-cyan-light)',
          dark: 'var(--note-cyan-dark)',
        },
        'note-rose': {
          light: 'var(--note-rose-light)',
          dark: 'var(--note-rose-dark)',
        },
      },
      animation: {
        'dock-slide-up': 'dockSlideUp 0.4s cubic-bezier(0.16, 1, 0.3, 1) forwards',
        'fade-in': 'fadeIn 0.2s ease-out forwards',
      },
      keyframes: {
        dockSlideUp: {
          '0%': { transform: 'translateY(100%)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
        fadeIn: {
          '0%': { opacity: '0', transform: 'scale(0.95)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        }
      }
    },
  },
  plugins: [],
}
