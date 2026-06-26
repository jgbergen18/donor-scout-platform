import Icon from './Icon';

export default function StatCard({ label, value, sub, icon, accent = false }) {
  return (
    <div className={`stat-card${accent ? ' stat-card--accent' : ''}`}>
      {icon && (
        <div className="stat-card__icon">
          <Icon name={icon} size={18} strokeWidth={2.25} />
        </div>
      )}
      <div className="stat-card__value">{value}</div>
      <div className="stat-card__label">{label}</div>
      {sub && <div className="stat-card__sub">{sub}</div>}
    </div>
  );
}
