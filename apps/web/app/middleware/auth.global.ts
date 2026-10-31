export default defineNuxtRouteMiddleware(async (to) => {
  const { me, loaded, fetchMe } = useAuth();
  if (!loaded.value) {
    await fetchMe();
  }

  if (to.meta.public) {
    return me.value ? navigateTo('/') : undefined;
  }

  if (!me.value) {
    return navigateTo({ path: '/login', query: to.fullPath === '/' ? {} : { redirect: to.fullPath } });
  }
});
