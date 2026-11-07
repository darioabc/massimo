import { createTheme } from '@mui/material/styles'

// A CSS-in-JS theme the way MUI and Chakra write one.
export const theme = createTheme({
  palette: {
    primary: { main: '#1976d2', contrastText: '#fff' },
    background: { default: '#fafafa' },
  },
  space: [0, 4, 8, 16],
  radii: { sm: 4, md: 8 },
  fonts: { body: 'Inter, system-ui, sans-serif' },
  fontWeights: { bold: 700 },
  shadows: { card: '0 1px 3px rgba(0,0,0,0.2)' },
  zIndices: { modal: 1300 },
  breakpoints: { values: { sm: 600 } },
  spacingUnit: brandSpacing * 2,
})
