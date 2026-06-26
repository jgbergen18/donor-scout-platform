import Icon from './Icon';

// Lightweight, accessible in-app help. Two reusable affordances, no UI deps:
//
//  <HelpTip label="...">explanation</HelpTip>
//    A small inline info button (native <details>/<summary>, so it's keyboard- and
//    screen-reader-accessible for free) that discloses a short explanation in place.
//
//  <HelpPanel /> — a compact "How Donor Scout works" card explaining the four core
//    concepts (relationship-led ranking, strategies, pipeline stages, capacity vs.
//    likelihood). Reuses the .card pattern and the same copy the product uses
//    elsewhere (StrategyPicker, the dashboard). Drop it on the Profile/Prospects
//    pages or anywhere a primer helps.

export function HelpTip({ label = 'What’s this?', children }) {
  return (
    <details className="helptip">
      <summary className="helptip__trigger" aria-label={label} title={label}>
        <Icon name="book" size={13} />
        <span className="helptip__label">{label}</span>
      </summary>
      <div className="helptip__body small">{children}</div>
    </details>
  );
}

// The canonical concept copy, shared so a tip and the panel never drift.
export const HELP_TOPICS = [
  {
    key: 'relationship',
    title: 'Relationship-led ranking',
    body: 'Donor Scout ranks prospects by how strongly they’re connected to you, not by how wealthy they look. A real relationship predicts a “yes” far better than perceived wealth.',
  },
  {
    key: 'strategies',
    title: 'Fundraising strategies',
    body: 'A strategy decides how three signals combine into the rank: Affinity (your relationship), Propensity (cause fit), and Capacity (giving capacity). Relationship-first is recommended; you can also weight them yourself.',
  },
  {
    key: 'pipeline',
    title: 'Pipeline stages',
    body: 'As you reach out, prospects move through stages: asked, following up, donated, or declined. The pipeline is your working list. Reminders keep your follow-ups on cadence.',
  },
  {
    key: 'capacity',
    title: 'Capacity vs. likelihood',
    body: 'Likelihood is whether they’ll give; capacity is how much they could give. Capacity should size the ask, not pick who to ask, so it’s always shown, whatever strategy you choose.',
  },
];

export function HelpPanel() {
  return (
    <section className="card help-panel">
      <h2>
        <Icon name="book" size={16} /> How Donor Scout works
      </h2>
      <dl className="help-panel__list">
        {HELP_TOPICS.map((t) => (
          <div className="help-panel__item" key={t.key}>
            <dt>{t.title}</dt>
            <dd className="muted small">{t.body}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
