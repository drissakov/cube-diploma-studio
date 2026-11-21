// A first visit needs a connection. Once the static build has been cached,
// the same address can reopen the editor and all three templates offline.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  const register = () => {
    navigator.serviceWorker.register('/sw.js', {updateViaCache: 'none'}).catch(() => {
      // Private browsing and storage limits can disable offline use.
      // The online editor does not depend on this cache.
    });
  };
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, {once: true});
}
