/**
 * Below the lg breakpoint: phones and tablets, where the sidebar collapses into the tab bar menu,
 * tables become lists and side panels open as sheets.
 */
export function useMobile(): Ref<boolean> {
  return useMediaQuery('(max-width: 1023.98px)');
}
