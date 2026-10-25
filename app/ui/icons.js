// Small inline icon set (24px grid, 1.8 stroke), so the app has no icon dependency.
const s = (d, extra = "") => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${d}</svg>`;

export const icon = {
  check: s('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  play: s('<path d="M8 5.5v13l11-6.5z" fill="currentColor" stroke="none"/>'),
  pause: s('<path d="M8 5v14M16 5v14" stroke-width="3"/>'),
  stop: s('<rect x="6.5" y="6.5" width="11" height="11" rx="2" fill="currentColor" stroke="none"/>'),
  mic: s('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0013 0M12 17.5V21"/>'),
  send: s('<path d="M5 12h13M13 6l6 6-6 6"/>'),
  close: s('<path d="M6 6l12 12M18 6L6 18"/>'),
  mail: s('<rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="M4 7l8 6 8-6"/>'),
  chat: s('<path d="M20 12a8 8 0 01-11.6 7.1L4 20l1-4.2A8 8 0 1120 12z"/>'),
  copy: s('<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6a1.5 1.5 0 00-1.5-1.5H6A1.5 1.5 0 004.5 6v8A1.5 1.5 0 006 15.5h2.5"/>'),
  car: s('<path d="M5 16v2.5M19 16v2.5M3.5 16h17v-4l-2-5.5h-13l-2 5.5z"/><circle cx="7.5" cy="13" r="1" fill="currentColor"/><circle cx="16.5" cy="13" r="1" fill="currentColor"/>'),
  today: s('<path d="M4 12.5l4.5 4.5L20 6"/>'),
  chart: s('<path d="M3.5 19.5h17"/><path d="M5 15.5l4.5-5 4 3.5 6-7"/>'),
  note: s('<path d="M6 3.5h9l4.5 4.5v12a.5.5 0 01-.5.5H6a.5.5 0 01-.5-.5V4a.5.5 0 01.5-.5z"/><path d="M14.5 3.5V8.5h5M9 13h6M9 16.5h4"/>'),
  inbox: s('<path d="M3.5 13.5l2.5-8h12l2.5 8v5a1 1 0 01-1 1h-15a1 1 0 01-1-1z"/><path d="M3.5 13.5h5l1 2.5h5l1-2.5h5"/>'),
  plug: s('<path d="M9 3.5v5M15 3.5v5M6.5 8.5h11v3a5.5 5.5 0 01-11 0zM12 17v3.5"/>'),
  ask: s('<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>'),
  gear: s('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.6 1.6 0 00-1.8-.3 1.6 1.6 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.6 1.6 0 00-1-1.5 1.6 1.6 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.6 1.6 0 00.3-1.8 1.6 1.6 0 00-1.5-1H3a2 2 0 110-4h.1a1.6 1.6 0 001.5-1 1.6 1.6 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.6 1.6 0 001.8.3H9a1.6 1.6 0 001-1.5V3a2 2 0 114 0v.1a1.6 1.6 0 001 1.5 1.6 1.6 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.6 1.6 0 00-.3 1.8V9a1.6 1.6 0 001.5 1H21a2 2 0 110 4h-.1a1.6 1.6 0 00-1.5 1z"/>'),
  upload: s('<path d="M12 15.5V4M7 8.5l5-5 5 5M4.5 15v4a1 1 0 001 1h13a1 1 0 001-1v-4"/>'),
  phone: s('<path d="M5 4h4l2 5-2.5 1.5a11 11 0 005 5L15 13l5 2v4a1 1 0 01-1 1A16 16 0 014 5a1 1 0 011-1z"/>'),
  doc: s('<path d="M7 3.5h7l4.5 4.5v12H7z"/><path d="M14 3.5V8h4.5"/>'),
};

// Neri mark: the brand artwork (ribbon rising to a sun on deep navy), as a square tile.
export const logo = `<img class="mark" src="./assets/neri-mark-96.png" srcset="./assets/neri-mark-64.png 1x, ./assets/neri-mark-96.png 2x, ./assets/neri-mark-192.png 3x" width="32" height="32" alt="" decoding="async" />`;
export const logoLarge = `<img class="mark mark-lg" src="./assets/neri-mark-192.png" srcset="./assets/neri-mark-192.png 1x, ./assets/neri-mark-512.png 2x" width="72" height="72" alt="" decoding="async" />`;
