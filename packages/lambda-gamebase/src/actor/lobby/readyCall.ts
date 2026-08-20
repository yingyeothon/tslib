/**
 * Sends the ready signal (HTTP PUT) to the lobby callback URL. Rejects
 * when the lobby answers with a non-200 status.
 */
export async function readyCall(callbackUrl: string): Promise<void> {
  const response = await fetch(callbackUrl, { method: "PUT" });
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new Error(`${response.status} ${response.statusText}`);
  }
  await response.body?.cancel();
}
