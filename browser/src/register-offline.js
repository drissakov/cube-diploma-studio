// Updates are staged in the background. An open editor keeps its current build
// until the user navigates or refreshes, including during a PDF export.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  const workers = navigator.serviceWorker;
  const release = document.querySelector('meta[name="studio-release"]')?.content;
  function identify() {
    if (release) workers.controller?.postMessage({studioRelease: release});
  }
  workers.addEventListener('controllerchange', identify);
  identify();
  async function register() {
    try {
      const registration = await workers.register('/sw.js', {updateViaCache: 'none'});
      const update = () => registration.update().catch(() => {});
      window.addEventListener('online', update);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') update();
      });
      if (registration.active) await update();
    } catch { /* Browsers with offline storage disabled can use the online editor. */ }
  }
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, {once: true});
}
