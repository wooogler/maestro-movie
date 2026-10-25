import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { bootTabletProfile } from './study/tabletProfileStorage'

// Before the first render: a profile URL (`?profile=tablet&code=...`) is
// stored and stripped from the address bar, and a session left behind by an
// earlier launch of a booth tablet is finished rather than resumed when nobody
// has touched the tablet for its idle window. See docs/scenarios/booth-tablet-setup.md.
const tabletBoot = bootTabletProfile()
if (tabletBoot.urlAction !== 'none' || tabletBoot.discardedSession) {
  console.info('[tablet]', {
    url: tabletBoot.urlAction,
    discardedSession: tabletBoot.discardedSession,
    profile: tabletBoot.profile
      ? { ...tabletBoot.profile, accessCode: tabletBoot.profile.accessCode ? '(set)' : '(none)' }
      : null,
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
