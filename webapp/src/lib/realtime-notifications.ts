export function isRealtimeNotificationsUnsupportedStatus(status: number): boolean {
  return status === 404 || status === 426 || status === 501;
}
