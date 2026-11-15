import { VERSION } from "./version";
export type ReleaseNote = { version: string; title: string; changes: string[]; upgrade: string[] };
// Bundled with the application: no network access or remote HTML required.
export const RELEASE_NOTES: ReleaseNote[] = [
  { version: "0.28.0-rc.2", title: "Release notes in Octavo", changes: ["See changes after an upgrade, with acknowledgement saved to your account.", "Reopen release history from the footer."], upgrade: ["Evaluation release. Back up the database and uploads before upgrading.", "Release acknowledgements use existing account settings storage; no schema or document content changes."] },
  { version: "0.28.0-rc.1", title: "Sign-in and disconnected exchange", changes: ["OIDC role and group mapping, configurable sessions and client-secret files.", "Signed manual exchange with conflict handling and deletion review.", "Optional incremental bundles and staging review."], upgrade: ["Automatic cross-site networking remains a disabled prototype, not a production sync service.", "Incremental exchange and staging are opt-in. Review deployment settings before enabling them."] },
];
export function compareVersions(a: string, b: string): number {
 const parse=(s:string)=>{const m=/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(s); if(!m)throw new Error("Invalid release version");return {core:m.slice(1,4).map(Number),pre:m[4]?.split(".")};};
 const x=parse(a),y=parse(b); for(let i=0;i<3;i++)if(x.core[i]!==y.core[i])return x.core[i]>y.core[i]?1:-1;
 if(!x.pre||!y.pre)return x.pre? -1:y.pre?1:0;
 for(let i=0;i<Math.max(x.pre.length,y.pre.length);i++){const a=x.pre[i],b=y.pre[i];if(a===b)continue;if(a===undefined)return -1;if(b===undefined)return 1;const an=/^\d+$/.test(a),bn=/^\d+$/.test(b);if(an&&bn)return Number(a)>Number(b)?1:-1;if(an!==bn)return an?-1:1;return a>b?1:-1;}return 0;
}
export function releaseHistory(current=VERSION) { return RELEASE_NOTES.filter(n=>compareVersions(n.version,current)<=0); }
export function unseenReleases(seen: string|null,current=VERSION) { return releaseHistory(current).filter(n=>!seen||compareVersions(n.version,seen)>0); }
