// Local OIDC identity provider for end-to-end SSO testing.
// Usage: node scripts/oidc-mock.mjs [port]
import { OAuth2Server } from "oauth2-mock-server";

const port = Number(process.argv[2] ?? 8525);
const server = new OAuth2Server();
await server.issuer.keys.generate("RS256");
server.service.on("beforeTokenSigning", (token) => {
  token.payload.email = "sso.tester@octavo.local";
  token.payload.name = "SSO Tester";
});
await server.start(port, "localhost");
console.log(`mock IdP up at ${server.issuer.url}`);
