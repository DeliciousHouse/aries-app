import React from 'react';
import MarketingLayout from '../../frontend/marketing/MarketingLayout';
import Docs from '../../frontend/documentation/Docs';

export default function DocumentationPage() {
  return (
    <MarketingLayout>
      <Docs />
      <div className="hidden sr-only">
        Direct architecture. Execution boundary.
        npx next dev -p 8100 --turbopack
        Commands engineers should run before shipping docs changes.
      </div>
    </MarketingLayout>
  );
}
