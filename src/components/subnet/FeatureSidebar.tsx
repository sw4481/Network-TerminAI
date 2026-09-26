export type FeatureType = 'cidr' | 'split' | 'vlsm' | 'super' | 'check' | 'visual';

export interface FeatureSidebarProps {
  activeFeature: FeatureType;
  onFeatureChange: (feature: FeatureType) => void;
}

export function FeatureSidebar({ activeFeature, onFeatureChange }: FeatureSidebarProps) {
  const features: { id: FeatureType; label: string; icon: string }[] = [
    { id: 'cidr', label: 'CIDR', icon: '🔢' },
    { id: 'split', label: 'Split', icon: '✂️' },
    { id: 'vlsm', label: 'VLSM', icon: '📊' },
    { id: 'super', label: 'Super', icon: '⬆️' },
    { id: 'check', label: 'Check', icon: '✓' },
    { id: 'visual', label: 'Visual', icon: '👁' },
  ];

  return (
    <div className="feature-sidebar">
      {features.map((feature) => (
        <button
          key={feature.id}
          onClick={() => onFeatureChange(feature.id)}
          className={`feature-button ${activeFeature === feature.id ? 'active' : ''}`}
          aria-label={`Switch to ${feature.label} tool`}
          aria-pressed={activeFeature === feature.id}
        >
          <span className="feature-icon">{feature.icon}</span>
          <span className="feature-label">{feature.label}</span>
        </button>
      ))}
    </div>
  );
}
