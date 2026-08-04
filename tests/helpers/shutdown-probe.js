/**
 * Boots a full server, then triggers the graceful-shutdown path directly.
 *
 * Windows has no real POSIX signals — `child.kill('SIGTERM')` calls
 * TerminateProcess, so a signal handler never runs and the shutdown path would
 * go untested on the platform this project is most often developed on. Invoking
 * `lifecycle.shutdown()` in-process exercises exactly the same code the SIGINT
 * handler runs, on every platform.
 */

const lifecycle = require('../../server/core/lifecycle');

(async () => {
  const { main } = require('../../server/index');
  await main();

  // Give the listener a moment to settle so the teardown has real work to do.
  setTimeout(() => lifecycle.shutdown('test-probe', 0), 300);
})().catch(err => {
  process.stderr.write(`probe failed: ${err?.stack || err}\n`);
  process.exit(1);
});
