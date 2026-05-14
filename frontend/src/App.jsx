import { useEffect, useRef, useState } from 'react';
import Sidebar from './components/Sidebar.jsx';
import PrescriptionTable from './components/PrescriptionTable.jsx';
import AddMedicineModal from './components/AddMedicineModal.jsx';
import InteractionPanel from './components/InteractionPanel.jsx';

export default function App() {
  const [prescription, setPrescription] = useState([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [interactions, setInteractions] = useState(null);
  const debounceRef = useRef(null);

  // re-check interactions whenever prescription changes (debounced 250 ms)
  useEffect(() => {
    clearTimeout(debounceRef.current);
    if (prescription.length < 2) { setInteractions(null); return; }
    debounceRef.current = setTimeout(async () => {
      try {
        const r = await fetch(`${import.meta.env.VITE_API_BASE || ''}/api/check`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ brands: prescription.map(p => p.brand_name) }),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        setInteractions(await r.json());
      } catch (e) {
        console.error('interaction check failed', e);
      }
    }, 250);
    return () => clearTimeout(debounceRef.current);
  }, [prescription]);

  const addMedicine = (med) => {
    setPrescription(p => [...p, med]);
    setModalOpen(false);
  };
  const removeMedicine = (idx) => {
    setPrescription(p => p.filter((_, i) => i !== idx));
  };

  return (
    <div className="app">
      <Sidebar />
      <main className="main">
        <header className="topbar">
          <div></div>
          <div className="profile">
            
            
          </div>
        </header>

        <div className="content">
          <section className="card">
            <h2 className="card-title">⚕ Treatments <span className="card-sub">Procedures and prescriptions</span></h2>
            <h3 className="section-title">Prescription (Medications)</h3>

            {(() => {
              const significantInteractions = interactions?.interactions?.filter(
                it => it.severity !== 'Unknown'
              ) || null;
              const filteredData = interactions ? {
                ...interactions,
                interactions: significantInteractions,
              } : null;

              return (
                <div style={{ display: 'flex', gap: 18, alignItems: 'flex-start' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <PrescriptionTable
                      medicines={prescription}
                      interactions={significantInteractions?.filter(it => it.severity === 'Major') || null}
                      onRemove={removeMedicine}
                      onAdd={() => setModalOpen(true)}
                    />
                  </div>
                  <div style={{ position: 'sticky', top: 20, flexShrink: 0 }}>
                    <InteractionPanel data={filteredData} hidden={prescription.length < 2} />
                  </div>
                </div>
              );
            })()}
          </section>
        </div>
      </main>

      

      {modalOpen && (
        <AddMedicineModal
          onClose={() => setModalOpen(false)}
          onAdd={addMedicine}
        />
      )}
    </div>
  );
}
