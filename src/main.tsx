import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './tokens.css'

import BadgePreview from './components/badge.preview'

// The gallery. Every component in this project has a preview beside it and
// they are all listed here. This file is not part of anyone's build task —
// leaving it alone is what stops one build disturbing another's work.
const previews = [
  ['badge', BadgePreview],
] as const

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <main>
      {previews.map(([name, Preview]) => (
        <section key={name}>
          <h2>{name}</h2>
          <Preview />
        </section>
      ))}
    </main>
  </StrictMode>,
)
