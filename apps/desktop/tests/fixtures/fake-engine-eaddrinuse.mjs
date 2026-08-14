// Fake engine that reports a taken port and exits: the shell must retry with
// a fresh port until its retry budget is spent. Every attempt appends a line
// to the FIXTURE_MARKER file so the test can count spawns.
import { appendFileSync } from 'node:fs'

const marker = process.env.FIXTURE_MARKER
if (marker === undefined) {
  console.error('fake engine: FIXTURE_MARKER is not set')
  process.exit(2)
}
appendFileSync(marker, 'run\n')
console.error('Error: listen EADDRINUSE: address already in use 127.0.0.1:34567')
process.exit(1)
