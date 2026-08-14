// Fake engine that fails before announcing: the shell must reject startup
// with the exit diagnostics instead of waiting out the readiness budget.
console.error('boom: fake engine exploded on boot')
process.exit(1)
