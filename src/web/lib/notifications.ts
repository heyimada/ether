const EVENT = "notifications-changed";

export const notificationsChanged = () => window.dispatchEvent(new Event(EVENT));

export function onNotificationsChanged(fn: () => void): () => void {
  window.addEventListener(EVENT, fn);
  return () => window.removeEventListener(EVENT, fn);
}
