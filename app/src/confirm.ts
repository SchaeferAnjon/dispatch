// A yes/no question before a destructive action: the browser's own confirm.
export async function confirmAction(message: string): Promise<boolean> {
  return window.confirm(message);
}
