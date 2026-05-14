import React, { useEffect, useRef, useState } from 'react';

/**
 * <InteractionPanel /> — drop into recordrx anywhere below the Prescription table.
 *
 * Props:
 *   medicines  : array of { brand_name } objects already in the prescription
 *   apiBase    : optional, defaults to '/api/interactions'
 *   getAuthHeaders : optional async () => ({ authorization: 'Bearer ...' })
 *
 * Auto-refreshes whenever `medicines` changes (debounced 250 ms).
 *
 *   <InteractionPanel medicines={prescription} />
 */
export default function InteractionPanel({
  medicines = [],
  apiBase = '/api/interactions',
  getAuthHeaders,
}) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const debounceRef = useRef(null);

  useEffect(() => {
    clearTimeout(debounceRef.current);
    if (medicines.length < 2) { setData(null); return; }

    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const headers = { 'content-type': 'application/json' };
        if (getAuthHeaders) Object.assign(headers, await getAuthHeaders());
        const r = await fetch(`${apiBase}/check`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ brands: medicines.map(m => m.brand_name) }),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        setData(await r.json());
      } catch (e) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    }, 250);

    return () => clearTimeout(debounceRef.current);
  }, [medicines, apiBase, getAuthHeaders]);

  if (medicines.length < 2) return null;
  if (loading && !data) return <div className="rx-warn-loading">Checking interactions…</div>;
  if (error) return <div className="rx-warn-error">Could not load interactions: {error}</div>;
  if (!data) return null;

  const total = data.interactions.length;
  const summary = data.severity_summary;
  const noData = data.no_data_ingredients;
  const unresolved = data.unresolved_brands;

  return (
    <div className="rx-warn">
      {/* Header */}
      {total === 0 && noData.length === 0 && unresolved.length === 0 ? (
        <div className="rx-warn-head ok">✓ No interactions found.</div>
      ) : (
        <div className="rx-warn-head">⚠ {total} interaction{total !== 1 ? 's' : ''} detected</div>
      )}

      {/* Severity pills */}
      {total > 0 && (
        <div className="rx-warn-summary">
          {['Major', 'Moderate', 'Minor', 'Unknown'].map(sev =>
            summary[sev] ? (
              <span key={sev} className={`rx-pill rx-pill-${sev.toLowerCase()}`}>
                {sev}: {summary[sev]}
              </span>
            ) : null
          )}
        </div>
      )}

      {unresolved.length > 0 && (
        <div className="rx-warn-note">
          ⚠ Could not find: <b>{unresolved.join(', ')}</b>. Use the autocomplete to pick from the catalog.
        </div>
      )}

      {noData.length > 0 && (
        <div className="rx-warn-note info">
          ℹ {noData.length} ingredient{noData.length !== 1 ? 's have' : ' has'} no interaction data:{' '}
          {noData.slice(0, 5).join(', ')}{noData.length > 5 ? '…' : ''}.
        </div>
      )}

      {/* Detailed list */}
      {data.interactions.map((it, i) => (
        <div key={i} className={`rx-warn-row sev-${it.severity.toLowerCase()}`}>
          <div className={`rx-sev rx-sev-${it.severity.toLowerCase()}`}>{it.severity}</div>
          <div className="rx-warn-body">
            <div className="rx-pair">
              <b>{it.brand_a}</b> + <b>{it.brand_b}</b>
            </div>
            <div className="rx-ings">
              {it.ingredient_a} ↔ {it.ingredient_b}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * <InteractionTriangle /> — small inline indicator next to one medicine row.
 * Use when you want a per-row badge showing "this medicine has interactions
 * with at least one other in the prescription".
 *
 *   <InteractionTriangle severity="Major" />
 */
export function InteractionTriangle({ severity }) {
  if (!severity) return null;
  const color = {
    Major: '#d9534f',
    Moderate: '#f0ad4e',
    Minor: '#5bc0de',
    Unknown: '#8a94a6',
  }[severity] || '#8a94a6';

  return (
    <span
      title={`${severity} interaction`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '2px 6px',
        borderRadius: 4,
        background: color,
        color: 'white',
        fontSize: 11,
        fontWeight: 600,
      }}
    >
      ⚠ {severity}
    </span>
  );
}
