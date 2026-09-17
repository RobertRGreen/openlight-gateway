import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [{
      find: /^node:sqlite$/,
      // vite-node 2 strips `node:` before externalizing prefix-only built-ins.
      // A native ESM re-export bypasses that normalization while still loading
      // Node's real DatabaseSync implementation (no SQLite mock or package).
      replacement: 'data:text/javascript,export%20*%20from%20%22node%3Asqlite%22%3B',
      customResolver: (id) => ({ id, external: true }),
    }],
  },
});
