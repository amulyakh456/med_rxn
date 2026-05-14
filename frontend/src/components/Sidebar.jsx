const ITEMS = [
  '🏠 Dashboard',
  '👥 Patients',
  '🩺 Doctors',
  '📅 Appointments',
  '🏥 Pharmacy',
  '🧾 Invoices',
  '💳 Payments',
  '🔧 Utility',
  '💊 Medicine',
  '📋 Services',
  '👤 Staff',
];

export default function Sidebar() {
  return (
    <aside className="sidebar">
<nav>
        {ITEMS.map((label, i) => (
          <a key={label} className={`nav-item ${i === 1 ? 'active' : ''}`}>{label}</a>
        ))}
      </nav>
    </aside>
  );
}
