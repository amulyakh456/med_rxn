import { useEffect, useRef, useState } from 'react';

export default function AddMedicineModal({ onClose, onAdd }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [picked, setPicked] = useState(null);
  const [freq, setFreq] = useState({ morn: 0, aft: 0, eve: 0, ngt: 0 });
  const [dur, setDur] = useState(0);
  const [qty, setQty] = useState(1);
  const [instr, setInstr] = useState('');
  const debounceRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  useEffect(() => {
    clearTimeout(debounceRef.current);
    if (query.trim().length < 2) { setResults([]); setShowSuggestions(false); return; }
    debounceRef.current = setTimeout(async () => {
      try {
        const r = await fetch(`${import.meta.env.VITE_API_BASE || ''}/api/search?q=${encodeURIComponent(query.trim())}`);
        const data = await r.json();
        setResults(data.results || []);
        setShowSuggestions(true);
      } catch (e) { console.error(e); }
    }, 180);
    return () => clearTimeout(debounceRef.current);
  }, [query]);

  const pick = (m) => {
    setPicked(m);
    setQuery(m.brand_name);
    setShowSuggestions(false);
  };

  const submit = () => {
    if (picked) {
      onAdd({ ...picked, ...freq, dur, qty, instr });
      return;
    }
    const typed = query.trim();
    if (!typed) { alert('Please type a medicine name.'); return; }
    // Free-text fallback — backend Gap 1 (Gemini) will resolve the medicine.
    onAdd({
      brand_name: typed,
      generic_name: '',
      dosage: '',
      dosage_form: '',
      manufacturer: '',
      unresolved_typed: true,
      ...freq, dur, qty, instr,
    });
  };

  return (
    <div className="modal-overlay open" onClick={(e) => { if (e.target.classList.contains('modal-overlay')) onClose(); }}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">Add Medicine</div>
          <button className="close" onClick={onClose}>✕</button>
        </div>

        <label className="lbl">Medicine <span className="req">*</span></label>
        <div className="searchbox">
          <input
            ref={inputRef}
            type="text"
            placeholder="Type to search 253K medicines (e.g. Crocin, Augmentin, Warf)"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setPicked(null); }}
            autoComplete="off"
          />
          {showSuggestions && (
            <div className="suggestions open">
              {results.length === 0 ? (
                <div className="sugg-item" style={{ color: 'var(--muted)', cursor: 'default' }}>
                  No matches
                </div>
              ) : results.map((m, i) => (
                <div key={i} className="sugg-item" onClick={() => pick(m)}>
                  <div className="sname">
                    {m.brand_name}
                    {m.dosage && <span style={{ color: 'var(--muted)', fontWeight: 400 }}> · {m.dosage}</span>}
                  </div>
                  <div className="sgen">
                    {m.generic_name}
                    {m.manufacturer && ` · ${m.manufacturer.slice(0, 40)}`}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {picked && (
          <div className="picked">
            <div className="pname">✓ {picked.brand_name}</div>
            <div className="pgen">
              {picked.generic_name}{picked.dosage ? ` · ${picked.dosage}` : ''}
            </div>
          </div>
        )}

        <div className="freq-grid">
          {['morn', 'aft', 'eve', 'ngt'].map((k, i) => (
            <div key={k}>
              <label className="lbl">{['Morning (M)', 'Afternoon (A)', 'Evening (E)', 'Night (N)'][i]}</label>
              <input type="number" min="0" value={freq[k]}
                onChange={(e) => setFreq({ ...freq, [k]: +e.target.value })} />
            </div>
          ))}
        </div>

        <div className="row2">
          <div>
            <label className="lbl">Duration (Days)</label>
            <input type="number" min="0" value={dur} onChange={(e) => setDur(+e.target.value)} />
          </div>
          <div>
            <label className="lbl">Quantity</label>
            <input type="number" min="1" value={qty} onChange={(e) => setQty(+e.target.value)} />
          </div>
        </div>

        <label className="lbl">Instruction</label>
        <textarea rows="2" value={instr} onChange={(e) => setInstr(e.target.value)}
          placeholder="Optional instructions for the patient" />

        <div className="modal-actions">
          <button className="btn cancel" onClick={onClose}>Cancel</button>
          <button className="btn add" onClick={submit}>Add ＋</button>
        </div>
      </div>
    </div>
  );
}
