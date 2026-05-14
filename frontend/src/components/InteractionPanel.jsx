import { useState } from 'react';

const SEV_BG = {
  Major:    '#d9534f',
  Moderate: '#f0ad4e',
  Minor:    '#5bc0de',
  Unknown:  '#8a94a6',
};

function InteractionItem({ it, isLast }) {
  return (
    <div style={{
      padding: '8px 0',
      borderBottom: isLast ? 'none' : '1px solid #f0e7c8',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3, flexWrap: 'wrap' }}>
        <span style={{
          background: SEV_BG[it.severity] || SEV_BG.Unknown,
          color: 'white',
          fontSize: 10,
          padding: '2px 6px',
          borderRadius: 3,
          fontWeight: 700,
          letterSpacing: '0.04em',
          whiteSpace: 'nowrap',
        }}>{it.severity.toUpperCase()}</span>
        <span style={{ fontSize: 12.5, fontWeight: 600 }}>
          {it.brand_a} + {it.brand_b}
        </span>
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--muted)', fontFamily: 'ui-monospace, monospace', marginBottom: 3 }}>
        {it.ingredient_a} ↔ {it.ingredient_b}
      </div>
      {it.clinical_effect && (
        <div style={{ fontSize: 12, color: 'var(--text)', lineHeight: 1.4 }}>
          {it.clinical_effect}
        </div>
      )}
      {it.side_effects && (
        <div style={{ fontSize: 12, color: 'var(--text)', lineHeight: 1.4 }}>
          <b>Effect:</b> {it.side_effects}
        </div>
      )}
      {it.mechanism && (
        <div style={{ fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.4 }}>
          <b>Mechanism:</b> {it.mechanism}
        </div>
      )}
      {it.clinical_action && (
        <div style={{ fontSize: 12, color: 'var(--text)', lineHeight: 1.4 }}>
          <b>Action:</b> {it.clinical_action}
        </div>
      )}
    </div>
  );
}

export default function InteractionPanel({ data, hidden }) {
  const [showLesser, setShowLesser] = useState(false);
  if (hidden || !data) return null;

  const total = data.interactions.length;
  const unresolved = data.unresolved_brands || [];

  const major = data.interactions.filter(it => it.severity === 'Major');
  const lesser = data.interactions.filter(it => it.severity !== 'Major');

  // All clear, no flags at all → small green chip
  if (total === 0 && unresolved.length === 0) {
    return (
      <aside style={{
        background: '#e8f8e8', border: '1px solid #c5e9c5', color: '#1f5e2c',
        padding: '8px 12px', borderRadius: 8, fontSize: 13, fontWeight: 500,
      }}>
        ✓ No interactions
      </aside>
    );
  }

  // Header colour: red if any Major, blue if only lesser/unresolved
  const tone = major.length > 0
    ? { bg: '#fff8e1', border: '#f6e7a8', fg: '#7a3a00' }
    : { bg: '#eef7ff', border: '#cde3f3', fg: '#1d4566' };

  return (
    <aside style={{
      background: tone.bg,
      border: `1px solid ${tone.border}`,
      borderRadius: 10,
      overflow: 'hidden',
      fontSize: 13,
      width: 260,
    }}>
      <div style={{
        padding: '10px 14px',
        color: tone.fg, fontWeight: 600,
      }}>
        <span>
          {major.length > 0 ? '⚠ ' : 'ℹ '}
          {major.length > 0 && `${major.length} major`}
          {major.length > 0 && lesser.length > 0 && ' · '}
          {lesser.length > 0 && `${lesser.length} ${major.length === 0 ? 'flag' : 'lesser'}${lesser.length !== 1 ? 's' : ''}`}
        </span>
      </div>

      {unresolved.length > 0 && (
        <div style={{ padding: '8px 14px', fontSize: 12.5, color: '#7a1f1f', background: 'rgba(255,255,255,0.4)' }}>
          ⚠ Could not find: <b>{unresolved.join(', ')}</b>
        </div>
      )}

      {/* Major interactions — always visible */}
      {major.length > 0 && (
        <div style={{ padding: '0 14px 4px', background: 'rgba(255,255,255,0.6)' }}>
          {major.map((it, i) => (
            <InteractionItem key={`maj-${i}`} it={it} isLast={i === major.length - 1} />
          ))}
        </div>
      )}

      {/* Lesser interactions — hidden behind a click */}
      {lesser.length > 0 && (
        <div style={{
          padding: '10px 14px',
          borderTop: major.length > 0 ? '1px solid #f0e7c8' : 'none',
          background: 'rgba(255,255,255,0.4)',
        }}>
          <button
            onClick={() => setShowLesser(s => !s)}
            style={{
              background: '#fff',
              border: '1px solid var(--border)',
              borderRadius: 6,
              padding: '6px 10px',
              fontSize: 12,
              cursor: 'pointer',
              fontWeight: 500,
              color: 'var(--text)',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              width: '100%',
              justifyContent: 'space-between',
            }}
          >
            <span>
              {showLesser ? '▾' : '▸'} {lesser.length} {major.length === 0 ? 'flag' : 'lesser flag'}{lesser.length !== 1 ? 's' : ''}
            </span>
            <span style={{ color: 'var(--muted)', fontSize: 11, fontWeight: 400 }}>
              {showLesser ? 'hide' : 'click to view'}
            </span>
          </button>

          {showLesser && (
            <div style={{ marginTop: 6 }}>
              {lesser.map((it, i) => (
                <InteractionItem key={`les-${i}`} it={it} isLast={i === lesser.length - 1} />
              ))}
            </div>
          )}
        </div>
      )}
    </aside>
  );
}
