// Same isolated real export/import fixture as browser QA, without launching a browser.
process.argv.push('--http-only');
await import('./package-integrity-ui-test.mjs');
