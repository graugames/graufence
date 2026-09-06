import type { ArenaView, FighterView } from '../render/arena3d.js';

function FighterCard({ fighter, align }: { fighter: FighterView; align: 'left' | 'right' }) {
  const health = Math.max(0, Math.min(100, fighter.health));
  const stamina = Math.max(0, Math.min(100, fighter.stamina));
  const accent = fighter.isSelf ? 'self' : 'foe';
  return (
    <section className={`arena-fighter-card ${accent} ${align}`} aria-label={`${fighter.name} status`}>
      <div className="arena-fighter-heading">
        <span>{fighter.isSelf ? (fighter.name && fighter.name !== 'You' ? `${fighter.name} · YOU` : 'YOU') : fighter.name}</span>
        <strong>{Math.round(health)} HP</strong>
      </div>
      <div className="arena-meter health" aria-label={`${Math.round(health)} health`}>
        <span className={health <= 30 ? 'low' : ''} style={{ width: `${health}%` }} />
      </div>
      <div className="arena-meter stamina" aria-label={`${Math.round(stamina)} stamina`}>
        <span style={{ width: `${stamina}%` }} />
      </div>
      <div className="arena-fighter-foot">
        <span>{fighter.staggered ? 'STAGGERED' : fighter.guard ? `GUARD · ${fighter.guard}` : 'READY'}</span>
        <span>{fighter.roundsWon} round{fighter.roundsWon === 1 ? '' : 's'}</span>
      </div>
    </section>
  );
}

function RoundScore({ view }: { view: ArenaView }) {
  return (
    <div className="arena-score" aria-label={`Round ${view.round}`}>
      <span className="arena-round-label">ROUND {Math.max(1, view.round)}</span>
      <div className="arena-score-pips">
        {[0, 1].map((index) => (
          <i key={`self-${index}`} className={index < view.me.roundsWon ? 'won self' : ''} />
        ))}
        <b>:</b>
        {[0, 1].map((index) => (
          <i key={`foe-${index}`} className={index < view.them.roundsWon ? 'won foe' : ''} />
        ))}
      </div>
    </div>
  );
}

export function ArenaHud({ view }: { view: ArenaView }) {
  const countdown = view.countdown === null ? null : Math.ceil(view.countdown);
  return (
    <div className="arena-hud" aria-live="polite">
      <div className="arena-fighter-row">
        <FighterCard fighter={view.me} align="left" />
        <RoundScore view={view} />
        <FighterCard fighter={view.them} align="right" />
      </div>

      {(countdown !== null || view.banner) && (
        <div className={`arena-callout ${view.bannerTone}`}>
          {countdown !== null ? (countdown > 0 ? countdown : 'FENCE!') : view.banner}
        </div>
      )}

      {view.trackingWarning && <div className="arena-tracking-warning">{view.trackingWarning}</div>}
    </div>
  );
}
