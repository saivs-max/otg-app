// Consistent stroke-based icon set (24×24, 2px, round caps) — Lucide-style.
// Iconography recommendation: outline icons for nav/actions, filled only for status.
const P = {
  home: 'M3 11.5 12 4l9 7.5M5 10v10h14V10M9.5 20v-6h5v6',
  clock: 'M12 7v5l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z',
  plus: 'M12 5v14M5 12h14',
  'plus-circle': 'M12 8v8M8 12h8M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z',
  receipt: 'M5 3v18l2-1 2 1 2-1 2 1 2-1 2 1V3l-2 1-2-1-2 1-2-1-2 1-2-1ZM8 8h8M8 12h8M8 16h5',
  file: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M9 13h6M9 17h4',
  'map-pin': 'M12 21s7-6.3 7-11a7 7 0 1 0-14 0c0 4.7 7 11 7 11ZM12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z',
  check: 'M4 12.5 9 17.5 20 6.5',
  'check-circle': 'M8.5 12.5 11 15l4.5-5M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z',
  alert: 'M12 9v4M12 17h.01M10.3 4.3 2.6 18a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0Z',
  'alert-circle': 'M12 8v4.5M12 16h.01M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z',
  info: 'M12 11v5M12 8h.01M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z',
  x: 'M6 6l12 12M18 6 6 18',
  'chevron-left': 'M15 6l-6 6 6 6',
  'chevron-right': 'M9 6l6 6-6 6',
  'chevron-down': 'M6 9l6 6 6-6',
  'arrow-right': 'M5 12h14M13 6l6 6-6 6',
  'arrow-up-right': 'M7 17 17 7M8 7h9v9',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM21 21l-4.3-4.3',
  filter: 'M3 5h18l-7 8v6l-4 2v-8L3 5Z',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 13a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 0 1-4 0v-.2A1.6 1.6 0 0 0 7 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H1a2 2 0 0 1 0-4h.2A1.6 1.6 0 0 0 2.6 7a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 7 2.6h.1A1.6 1.6 0 0 0 8 1.2V1a2 2 0 0 1 4 0v.2A1.6 1.6 0 0 0 14.8 2.6a1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V7a1.6 1.6 0 0 0 1.4 1h.2a2 2 0 0 1 0 4h-.2a1.6 1.6 0 0 0-1.4 1Z',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM5 21c0-3.9 3.1-7 7-7s7 3.1 7 7',
  users: 'M9 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM2 21c0-3.9 3.1-6.5 7-6.5M16 4.5a4 4 0 0 1 0 7.5M14.5 14.7c3 .4 5.5 2.6 5.5 6.3',
  shield: 'M12 3 5 6v6c0 4.5 3 7.7 7 9 4-1.3 7-4.5 7-9V6zM9 12l2 2 4-4',
  card: 'M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM3 10h18M7 15h4',
  trending: 'M3 17l6-6 4 4 8-8M15 7h6v6',
  'bar-chart': 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  'pie-chart': 'M12 3a9 9 0 1 0 9 9h-9z M12 3v9h9',
  calendar: 'M7 3v3M17 3v3M4 8h16M5 6h14a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1Z',
  truck: 'M3 6h11v9H3zM14 9h4l3 3v3h-7zM7 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM18 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z',
  briefcase: 'M3 8h18v11H3zM8 8V6a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 13h18',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  lock: 'M6 10V8a6 6 0 1 1 12 0v2M5 10h14v10H5zM12 14v3',
  menu: 'M4 6h16M4 12h16M4 18h16',
  edit: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
  trash: 'M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13',
  camera: 'M4 8h3l2-2h6l2 2h3v11H4zM12 16a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  upload: 'M12 16V4M7 9l5-5 5 5M5 20h14',
  download: 'M12 4v12M7 11l5 5 5-5M5 20h14',
  send: 'M22 2 11 13M22 2l-7 20-4-9-9-4z',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  'more-vertical': 'M12 6h.01M12 12h.01M12 18h.01',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM13 13h7v7h-7zM4 13h7v7H4z',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  building: 'M4 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16M16 21h4V9a2 2 0 0 0-2-2h-2M8 7h4M8 11h4M8 15h4',
  gauge: 'M12 14l4-4M5.5 19a9 9 0 1 1 13 0z',
  sparkles: 'M12 3l1.8 4.7L18.5 9l-4.7 1.3L12 15l-1.8-4.7L5.5 9l4.7-1.3zM19 14l.8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8zM6 15l.6 1.6L8 17l-1.4.4L6 19l-.6-1.6L4 17l1.4-.4z',
  refresh: 'M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5',
  bell: 'M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M10.3 21a1.9 1.9 0 0 0 3.4 0',
  flag: 'M4 22V4M4 4h12l-2 4 2 4H4',
  paid: 'M12 7v10M9.5 9.2c0-1 .9-1.7 2.5-1.7s2.5.7 2.5 1.8c0 2.5-5 1.2-5 3.7 0 1.1 1 1.8 2.5 1.8s2.5-.7 2.5-1.7M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z',
  inbox: 'M3 12h5l2 3h4l2-3h5M5 5h14l2 7v7H3v-7zM5 5 3 12M19 5l2 7',
  link: 'M9 15l6-6M10 6l1-1a4 4 0 0 1 6 6l-1 1M14 18l-1 1a4 4 0 0 1-6-6l1-1',
  play: 'M7 5l12 7-12 7z',
  square: 'M6 6h12v12H6z',
  history: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 4v4h4M12 8v4l3 2',
}

export default function Icon({ name, size = 20, className = '', strokeWidth = 2, fill = false, ...rest }) {
  const d = P[name]
  if (!d) return null
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false"
      fill={fill ? 'currentColor' : 'none'} stroke={fill ? 'none' : 'currentColor'}
      strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round"
      className={className} {...rest}
    >
      {d.split('M').filter(Boolean).map((seg, i) => <path key={i} d={'M' + seg} />)}
    </svg>
  )
}
