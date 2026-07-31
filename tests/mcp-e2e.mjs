/**
 * End-to-end check with a real MCP client over streamable HTTP.
 *
 * Deliberately not a curl of the HTTP endpoint: that proves the route exists,
 * not that an LLM client can complete a handshake, enumerate tools and get live
 * values back. This is the thing that either works or doesn't.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const URL = process.env.MCP_URL || 'http://127.0.0.1:1880/mcp';
const parse = (r) => JSON.parse(r.content[0].text);

const client = new Client({ name: 'e2e', version: '1.0.0' }, { capabilities: {} });
await client.connect(new StreamableHTTPClientTransport(new global.URL(URL)));
console.log('connected to', URL);

const tools = await client.listTools();
console.log('tools:', tools.tools.map((t) => t.name).join(', '));

const writeTools = tools.tools.filter((t) => /write|set|force|command/i.test(t.name));
console.log('write-capable tools:', writeTools.length === 0 ? 'NONE (by design)' : writeTools.map(t => t.name));

const devices = parse(await client.callTool({ name: 'list_devices', arguments: {} }));
const device = devices[0].device;
console.log(`device: ${device} — ${devices[0].tags} tags`);

const tags = parse(await client.callTool({ name: 'list_tags', arguments: { device } }));
console.log('tags:', tags.map((t) => `${t.tag}${t.unit ? ' [' + t.unit + ']' : ''}`).join(', '));

console.log('\nsearch "pressure":');
for (const t of parse(await client.callTool({ name: 'search_tags', arguments: { device, query: 'pressure' } }))) {
    console.log(`  ${t.tag} — ${t.description}`);
}

console.log('\nread_all:');
const all = parse(await client.callTool({ name: 'read_all', arguments: { device } }));
for (const r of all) {
    const v = typeof r.value === 'number' ? r.value.toFixed(2) : String(r.value);
    console.log(
        `  ${r.tag.padEnd(21)} ${String(v).padStart(9)} ${(r.unit || '').padEnd(5)}` +
        ` ${r.quality.padEnd(6)} ${r.kind}@${r.address} raw=${JSON.stringify(r.raw)} age=${r.age_seconds}s`
    );
}

console.log('\nread_tag on one point:');
console.log(JSON.stringify(parse(await client.callTool({
    name: 'read_tag', arguments: { device, tag: 'bearing_temperature' },
})), null, 2));

console.log('\nunknown tag should fail helpfully:');
const bad = await client.callTool({ name: 'read_tag', arguments: { device, tag: 'pressure' } });
console.log(' ', bad.content[0].text);

const good = all.filter((r) => r.quality === 'good').length;
console.log(`\nRESULT: ${good}/${all.length} tags reading good`);
await client.close();
process.exit(good === all.length ? 0 : 1);
