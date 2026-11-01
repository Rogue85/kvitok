export default defineAppConfig({
  ui: {
    colors: { primary: 'brand', neutral: 'stone' },
    // Below lg the menu opens from the tab bar, so the navbar keeps its width for the title and actions.
    dashboardNavbar: { slots: { toggle: 'hidden' } },
    // Panels fill the group, which leaves room for the tab bar and the safe areas.
    dashboardPanel: { slots: { root: 'min-h-0' } },
  },
});
