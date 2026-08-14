// Fake `dsh --profile web` engine for desktop-shell handshake tests: serves
// HTTP on the --port argument and announces the `dsh web:` URL line the shell
// waits for. Runs until the shell kills it.
import { createServer } from 'node:http'

const portArg = process.argv.indexOf('--port')
const port = portArg >= 0 ? Number(process.argv[portArg + 1]) : 0
const server = createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/plain' })
  response.end('ok')
})
server.listen(port, '127.0.0.1', () => {
  console.log(`dsh web: http://127.0.0.1:${port}`)
})
