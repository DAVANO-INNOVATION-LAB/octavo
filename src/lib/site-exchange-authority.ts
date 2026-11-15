import "server-only";
import {getDb} from "./db";
import {canAdminSpace} from "./roles";
import type {User} from "./auth";

/** Request authority is re-read at the last synchronous boundary, never cached
 * across an upload, dynamic import or staging verifier. Internal callers that
 * omit a guard remain responsible for their own trusted execution boundary. */
export type ExchangeAuthority = () => void;
export class ExchangeAuthorityError extends Error {
  constructor(){super("Exchange authorization changed");}
}
export function exchangeSessionAuthority(sessionId:string|undefined,actorId:string,spaceId?:string):ExchangeAuthority {
 return ()=>{
  if(!sessionId)throw new ExchangeAuthorityError();
  const user=getDb().prepare(`SELECT u.id,u.email,u.name,u.role,u.active,s.expires_at
   FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=?`).get(sessionId) as (User&{active:number;expires_at:number})|undefined;
  if(!user||user.id!==actorId||user.active!==1||user.role!=="admin"||user.expires_at<=Date.now()||(spaceId&&!canAdminSpace(user,spaceId)))throw new ExchangeAuthorityError();
 };
}
