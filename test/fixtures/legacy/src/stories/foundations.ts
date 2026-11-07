// The token pages read the generated token list.
import tokens from '../../docs/system/tokens.json'

export const names = tokens.tokens.map((t) => t.name)
