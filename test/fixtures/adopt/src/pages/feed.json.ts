// The glyphs the feed names, read lazily.
const glyphs = import.meta.glob<string>('@/components/Icon.tsx')

export const GET = () => new Response(JSON.stringify(Object.keys(glyphs)))
