import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { SupportSurface } from './pages/SupportSurface.tsx'
import './styles.css'

const root = document.getElementById('root')
if (!root) throw new Error('#root is missing from index.html')

createRoot(root).render(
  <StrictMode>
    <SupportSurface />
  </StrictMode>,
)
