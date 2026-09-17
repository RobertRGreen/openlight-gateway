import { loadConfig } from '../config/index.js';
import { GatewayStore } from '../persistence/index.js';
import { TokenService } from '../security/index.js';

// Local administration only. Plaintext is printed once to stdout, never logged.
const [command = 'create', id, overlap = '0'] = process.argv.slice(2);
if (!['create', 'rotate', 'revoke'].includes(command) || (command !== 'create' && !id)) {
  process.stderr.write('Usage: token [create | rotate TOKEN_ID [OVERLAP_MS] | revoke TOKEN_ID]\n');
  process.exitCode = 1;
} else {
  const config = loadConfig();
  const store = new GatewayStore(config.databasePath);
  try {
    const tokens = new TokenService(store, config.apiTokenSalt);
    if (command === 'revoke') tokens.revoke(id!);
    else process.stdout.write(`${command === 'rotate' ? tokens.rotate(id!, Number(overlap)).token : tokens.create().token}\n`);
  } catch {
    process.stderr.write('Token administration failed. Check the token ID and overlap duration.\n');
    process.exitCode = 1;
  } finally { store.close(); }
}
