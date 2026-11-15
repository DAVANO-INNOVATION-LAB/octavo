/** Mirror src/lib collaboration config. No legacy attached-server persistence. */
function collaborationEnabled(env = process.env) {
  const value=env.OCTAVO_COLLAB_PERSISTENCE;
  if (![undefined,"","0","1","experimental"].includes(value))
    throw new Error("Invalid OCTAVO_COLLAB_PERSISTENCE: expected 0, 1, experimental, or unset");
  return env.OCTAVO_COLLAB !== "0" && value !== "0";
}

module.exports = { collaborationEnabled };
