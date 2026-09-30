#!/usr/bin/env node
// Compatibility shim for old TokenRank install paths. Never load the forked scanner/Store.
console.error('[tokenrank] 此路径现在使用独立只读同步器；原版 token-watcher 请通过其自己的命令运行。');
await import('./tokenrank.js');
