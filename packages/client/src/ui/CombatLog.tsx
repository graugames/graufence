/**
 * The combat log.
 *
 * A fencing exchange resolves in about a fifth of a second, and both players
 * routinely have no idea why they just lost 20 health. The log is the answer:
 * it names the outcome, the line, and the number, in the order they happened.
 *
 * Newest first, capped at a readable length (see pushLog), and coloured by
 * outcome so it can be skimmed at a glance mid-match.
 */

import { useApp } from '../state/app.js';

export function CombatLog() {
  const log = useApp((s) => s.log);

  return (
    <ul className="combat-log" aria-live="polite" aria-label="Combat log">
      {log.slice(0, 8).map((entry) => (
        <li key={entry.id} className={`log-${entry.tone}`}>
          {entry.text}
        </li>
      ))}
    </ul>
  );
}
