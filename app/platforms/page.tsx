import React from 'react';
import AppShellLayout from '../../frontend/app-shell/layout';
import AriesSettingsScreen from '@/frontend/aries-v1/settings-screen';

export default function PlatformsPage() {
  return (
    <AppShellLayout currentRouteId="settings">
      <AriesSettingsScreen />
    </AppShellLayout>
  );
}
