// Registers the service worker that makes the game installable and lets
// single-player (vs AI) start offline. Multiplayer still needs the server.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('/sw.js').catch(function () {});
  });
}
