// Local, deterministic MCP peer used only by integration tests.
const readline = require('node:readline');
const expectedAbsent = process.argv.find((argument) => argument.startsWith('--absent-env='))?.slice(13);
if (expectedAbsent && Object.hasOwn(process.env, expectedAbsent)) process.exit(2);
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result;
  switch (request.method) {
    case 'initialize':
      result = {
        protocolVersion: request.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'emergence-proof', version: '1.0.0' },
      };
      break;
    case 'ping':
      result = {};
      break;
    case 'tools/list':
      result = {
        tools: [
          {
            name: 'echo',
            description: 'Echo a test value',
            inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
          },
        ],
      };
      break;
    case 'tools/call':
      if (process.argv.includes('--hang-call')) return;
      result = { content: [{ type: 'text', text: 'MCP:' + request.params.arguments.value }] };
      break;
    default:
      process.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          error: { code: -32601, message: 'Method not found' },
        }) + '\n',
      );
      return;
  }
  const respond = () =>
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
  if (request.method === 'initialize' && process.argv.includes('--delay-init')) setTimeout(respond, 250);
  else respond();
});
