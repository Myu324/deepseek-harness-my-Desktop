// Fake engine that never announces nor listens: the shell's readiness budget
// must expire and terminate this process.
setInterval(() => {}, 1000)
