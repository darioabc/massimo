// Renders the button's frame from a running lane into images the site ships.
const BASE = process.env.LAB_URL ?? 'http://localhost:4400'
const FRAME = `${BASE}/stories/button/frame`

export const url = FRAME
