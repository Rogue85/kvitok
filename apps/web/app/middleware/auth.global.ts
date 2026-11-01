export default defineNuxtRouteMiddleware(async (to) => {
  const { me, loaded, fetchMe, checkSetup } = useAuth();
  if (!loaded.value) {
    await fetchMe();
  }

  // A fresh installation starts with the first-run setup instead of the sign-in form.
  if (!me.value && to.path !== '/setup' && (!to.meta.public || to.path === '/login') && (await checkSetup())) {
    return navigateTo('/setup');
  }

  if (to.meta.public) {
    return me.value && !to.meta.keepSession ? navigateTo('/') : undefined;
  }

  if (!me.value) {
    return navigateTo({ path: '/login', query: to.fullPath === '/' ? {} : { redirect: to.fullPath } });
  }

  if (to.meta.superadmin && !me.value.user.isSuperadmin) {
    return navigateTo('/');
  }
});
