import './workspace-welcome.css'

export function WorkspaceWelcome({ navigate }: { navigate: (page: 'observations' | 'ai') => void }) {
  return <section className="sw-welcome" aria-labelledby="sw-title">
    <div className="sw-welcome-copy"><span className="eyebrow">Signal awareness. Guarded intelligence.</span><h1 id="sw-title">SignalWarden AI</h1><p>A local-first observation and evidence workspace. Understand source uncertainty before trusting the picture.</p><div className="sw-boundaries"><span>READ ONLY</span><span>ADVISORY AI</span><span>SYNTHETIC DEMO</span></div></div>
    <div className="sw-launch-links"><button onClick={() => navigate('observations')}><strong>Explore observations <span>↗</span></strong><small>Source health, exact citations, conflicts and recovery</small></button><button onClick={() => navigate('ai')}><strong>Set up local AI <span>↗</span></strong><small>Five optional model tasks · explicit install only</small></button></div>
    <p className="sw-brand-note">Provisional display name · no trademark clearance claimed. No live Lattice integration or vehicle / effector command routing.</p>
  </section>
}
