/**
 * Runs once when the server boots. Anything that has to be *running* rather
 * than waiting to be called starts here.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { isReplica } = await import("./lib/db");
  if (isReplica()) {
    const { scheduleReplicaPull } = await import("./lib/replica");
    scheduleReplicaPull();
  } else {
    const { scheduleReplication } = await import("./lib/replicate");
    scheduleReplication();
  }
}
