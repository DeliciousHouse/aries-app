import React from 'react';
import AppShellLayout from '../../frontend/app-shell/layout';
import IntegrationsScreen from '../../frontend/settings/integrations';

export default function PlatformsPage() {
  return (
    <AppShellLayout currentRouteId="platforms">
      <IntegrationsScreen />
    </AppShellLayout>
  );
}
