/** The running release, to quote in a bug report. Health answers 503 while a dependency is down: the version is then null. */
export function useVersion() {
  const { data } = useAsyncData('version', () =>
    api<{ version: string }>('/health').then(
      (health) => health.version,
      () => null,
    ),
  );
  return data;
}
