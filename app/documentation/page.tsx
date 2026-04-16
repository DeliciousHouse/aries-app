import React from 'react';
import MarketingLayout from '../../frontend/marketing/MarketingLayout';
import Docs from '../../frontend/documentation/Docs';

export const metadata = {
  title: 'Documentation — Aries AI',
  description: 'Getting started with Aries AI — how to create your first campaign, connect channels, and approve creative.',
};

export default function DocumentationPage() {
  return (
    <MarketingLayout>
      <Docs />
    </MarketingLayout>
  );
}
