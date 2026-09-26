import { useState } from 'react';
import type { Tab } from '../../lib/types';
import { FeatureSidebar, type FeatureType } from './FeatureSidebar';
import { QuickReference } from './QuickReference';
import { CidrCalculator } from './tools/CidrCalculator';
import { SubnetSplitter } from './tools/SubnetSplitter';
import { VlsmDesigner } from './tools/VlsmDesigner';
import { SupernettingTool } from './tools/SupernettingTool';
import { IpChecker } from './tools/IpChecker';
import { SubnetVisualizer } from './tools/SubnetVisualizer';
import './SubnetTab.css';

export interface SubnetTabProps {
  tab: Tab;
}

export function SubnetTab({ }: SubnetTabProps) {
  const [activeFeature, setActiveFeature] = useState<FeatureType>('cidr');
  const [referenceOpen, setReferenceOpen] = useState(false);

  const renderActiveTool = () => {
    switch (activeFeature) {
      case 'cidr':
        return <CidrCalculator />;
      case 'split':
        return <SubnetSplitter />;
      case 'vlsm':
        return <VlsmDesigner />;
      case 'super':
        return <SupernettingTool />;
      case 'check':
        return <IpChecker />;
      case 'visual':
        return <SubnetVisualizer />;
      default:
        return <CidrCalculator />;
    }
  };

  return (
    <div className="subnet-tab">
      <FeatureSidebar
        activeFeature={activeFeature}
        onFeatureChange={setActiveFeature}
      />

      <div className="subnet-workspace">
        {renderActiveTool()}
      </div>

      <div className="subnet-reference-container">
        <QuickReference
          isOpen={referenceOpen}
          onToggle={() => setReferenceOpen(!referenceOpen)}
        />
      </div>
    </div>
  );
}
