/**
 * Runs once when the server boots. Anything that has to be *running* rather
 * than waiting to be called starts here.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { scheduleReplication } = await import("./lib/replicate");
  scheduleReplication();
}
