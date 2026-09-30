// Navigation between screens (the URL hash). Each dashboard's main.js registers its route function,
// so screens can call go() without importing every other screen.
let routeFn = () => {}

export function setRoute(fn) {
  routeFn = fn
}

// Re-render the current screen.
export const refresh = () => routeFn()

// go(hash, force): change screen; `force` re-renders when already there.
export function go(hash, force) {
  if (location.hash === hash && force) routeFn()
  else location.hash = hash
}
