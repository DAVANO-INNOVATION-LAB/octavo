import "server-only";
import { getDb } from "./db";
import { VERSION } from "./version";
import { compareVersions, releaseHistory, unseenReleases } from "./release-notes";
export function releaseState(userId:string) {
 const row=getDb().prepare("SELECT value AS version FROM kv WHERE key=?").get(`release-seen:${userId}`) as {version:string}|undefined;
 return {userId,version:VERSION, previousVersion:row?.version??null, history:releaseHistory(), unread:unseenReleases(row?.version??null)};
}
export function acknowledgeRelease(userId:string) {
 const db=getDb();db.transaction(()=>{const row=db.prepare("SELECT value AS version FROM kv WHERE key=?").get(`release-seen:${userId}`) as {version:string}|undefined;
 if(!row||compareVersions(VERSION,row.version)>0)db.prepare("INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(`release-seen:${userId}`,VERSION);
 })();
}
