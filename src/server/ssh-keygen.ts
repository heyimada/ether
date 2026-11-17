// Default import: the e2e helpers load this under Node, where ssh2 (CommonJS) has no named exports.
import ssh2 from "ssh2";

const { utils } = ssh2;

// A new ed25519 key pair in OpenSSH format. ssh2 now and then writes a private key that neither it nor OpenSSH can
// read back (about 1 in 170), so a pair only counts once its private key parses.
export function newEd25519Key(): { private: string; public: string } {
  for (let tries = 0; tries < 20; tries++) {
    const pair = utils.generateKeyPairSync("ed25519");
    if (!(utils.parseKey(pair.private) instanceof Error)) return pair;
  }
  throw new Error("Could not generate a usable ed25519 key");
}
