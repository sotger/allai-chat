#!/usr/bin/env node
// Clears ELECTRON_RUN_AS_NODE before starting electron-vite dev server.
// This is needed when running inside Claude Code (or any Electron-based editor)
// which sets ELECTRON_RUN_AS_NODE=1 in the environment, causing Electron to
// run as plain Node.js and lose access to the electron API.
delete process.env.ELECTRON_RUN_AS_NODE;
const { spawnSync } = require('child_process');
const result = spawnSync('electron-vite', ['dev'], { stdio: 'inherit', shell: true });
process.exit(result.status ?? 0);
