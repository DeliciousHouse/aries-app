import React from 'react';
import AppShellLayout from '../../frontend/app-shell/layout';
import SettingsScreen from '../../frontend/settings';

export default function SettingsPage() {
  return (
    <AppShellLayout currentRouteId="settings">
      <SettingsScreen />
    </AppShellLayout>
  );
}
