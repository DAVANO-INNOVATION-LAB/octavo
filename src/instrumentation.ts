/**
 * Runs once when the server boots. Anything that has to be *running* rather
 * than waiting to be called starts here.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { isReplica } = await import("./lib/db");

  // Attribute existing uploads to the spaces already using them. Without it
  // every file that predates the access rule becomes unreadable, and a fix
  // that empties the images out of a working library is not a fix.
  if (!isReplica()) {
    const { backfillUploadRefs } = await import("./lib/uploads");
    try {
      const n = backfillUploadRefs();
      if (n > 0) console.log(`octavo: attributed ${n} upload reference(s) to their spaces`);
    } catch {
      // A failed backfill must not stop the server booting.
    }
  }

  if (isReplica()) {
    const { scheduleReplicaPull } = await import("./lib/replica");
    scheduleReplicaPull();
    // A standby watches the lease so that promotion is a decision already
    // made by the time anyone looks, rather than one taken under pressure.
    const { scheduleFailoverWatch } = await import("./lib/failover");
    scheduleFailoverWatch();
  } else {
    const { scheduleReplication } = await import("./lib/replicate");
    scheduleReplication();
    // Restoring the backup is the only thing that proves the backup. Doing it
    // on a timer means a broken one is found within a day, rather than on the
    // day it is needed.
    const { scheduleRestoreDrill } = await import("./lib/restore-drill");
    const { getDb } = await import("./lib/db");
    scheduleRestoreDrill(() => {
      try {
        return (getDb().prepare("SELECT COUNT(*) AS c FROM pages").get() as { c: number }).c;
      } catch {
        return 0;
      }
    });
  }
}
