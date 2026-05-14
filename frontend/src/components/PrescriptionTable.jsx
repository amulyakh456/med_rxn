// Severity ordering for picking the worst case per medicine
const SEV_RANK = { Major: 0, Moderate: 1, Minor: 2, Unknown: 3 };
const SEV_COLOR = {
  Major:    '#d9534f',
  Moderate: '#f0ad4e',
  Minor:    '#5bc0de',
  Unknown:  '#8a94a6',
};

/**
 * Reduce the interaction list down to the WORST severity each medicine is
 * involved in, plus the count and the partner medicines (for tooltip).
 */
function buildPerMedicineSeverity(medicines, interactions) {
  const map = new Map();
  if (!interactions) return map;

  for (const it of interactions) {
    for (const brand of [it.brand_a, it.brand_b]) {
      const cur = map.get(brand);
      const partner = brand === it.brand_a ? it.brand_b : it.brand_a;
      if (!cur) {
        map.set(brand, { severity: it.severity, count: 1, partners: [partner] });
      } else {
        cur.count += 1;
        cur.partners.push(partner);
        if (SEV_RANK[it.severity] < SEV_RANK[cur.severity]) cur.severity = it.severity;
      }
    }
  }
  return map;
}

function SeverityBadge({ info }) {
  if (!info) return null;
  const color = SEV_COLOR[info.severity] || SEV_COLOR.Unknown;
  const tooltip = `${info.severity} interaction${info.count > 1 ? 's' : ''} with ${info.partners.join(', ')}`;
  return (
    <span
      title={tooltip}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 3,
        marginLeft: 8,
        padding: '1px 6px 1px 4px',
        borderRadius: 4,
        background: color,
        color: 'white',
        fontSize: 10.5,
        fontWeight: 700,
        letterSpacing: '0.04em',
        verticalAlign: 'middle',
      }}
    >
      ⚠ {info.severity.toUpperCase()}{info.count > 1 ? ` ×${info.count}` : ''}
    </span>
  );
}

export default function PrescriptionTable({ medicines, interactions, onRemove, onAdd }) {
  const sevMap = buildPerMedicineSeverity(medicines, interactions);

  return (
    <div className="rx-table">
      <div className="rx-header">
        <div>Medication</div>
        <div>M</div><div>A</div><div>E</div><div>N</div>
        <div>Duration</div><div>Quantity</div><div>Instructions</div><div>Act</div>
      </div>

      <div>
        {medicines.length === 0 && (
          <div className="rx-row" style={{ color: 'var(--muted)' }}>
            <div style={{ gridColumn: '1 / -1', textAlign: 'center' }}>
              No medicines added yet
            </div>
          </div>
        )}
        {medicines.map((m, i) => {
          const info = sevMap.get(m.brand_name);
          return (
            <div className="rx-row" key={i}>
              <div>
                <div className="pill-name">
                  {m.brand_name}
                  <SeverityBadge info={info} />
                </div>
                <div className="pill-gen">{m.generic_name}</div>
              </div>
              <div>{m.morn}</div>
              <div>{m.aft}</div>
              <div>{m.eve}</div>
              <div>{m.ngt}</div>
              <div>{m.dur} d</div>
              <div>{m.qty}</div>
              <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>{m.instr || '—'}</div>
              <div>
                <button className="del" onClick={() => onRemove(i)}>✕</button>
              </div>
            </div>
          );
        })}
      </div>

      <button className="add-btn" onClick={onAdd}>＋ Add Medicine</button>
    </div>
  );
}
