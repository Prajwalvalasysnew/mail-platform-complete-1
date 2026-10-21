// Rehype plugin: render one-line, language-less code blocks such as
//   ```
//   POST /v1/send
//   ```
// as an endpoint bar with a coloured HTTP-method badge (API reference style).
// The markdown stays plain and portable; only the rendered site changes.

const ENDPOINT = /^(GET|POST|PUT|PATCH|DELETE)\s+(\/\S*)$/;

const text = (node) =>
  node.type === 'text' ? node.value : (node.children || []).map(text).join('');

function endpointOf(node) {
  if (node.type !== 'element' || node.tagName !== 'pre' || node.children?.length !== 1) return null;
  const code = node.children[0];
  if (code.type !== 'element' || code.tagName !== 'code') return null;
  const classes = [].concat(code.properties?.className || []);
  if (classes.some((c) => String(c).startsWith('language-'))) return null;
  const match = ENDPOINT.exec(text(code).trim());
  return match ? { method: match[1], path: match[2] } : null;
}

function endpointBar({ method, path }) {
  return {
    type: 'element',
    tagName: 'div',
    properties: { className: ['api-endpoint'] },
    children: [
      { type: 'element', tagName: 'span', properties: { className: ['api-method', `api-method--${method.toLowerCase()}`] }, children: [{ type: 'text', value: method }] },
      { type: 'element', tagName: 'code', properties: { className: ['api-path'] }, children: [{ type: 'text', value: path }] },
    ],
  };
}

function walk(node) {
  if (!node.children) return;
  node.children = node.children.map((child) => {
    const endpoint = endpointOf(child);
    if (endpoint) return endpointBar(endpoint);
    walk(child);
    return child;
  });
}

export default function apiEndpoints() {
  return (tree) => walk(tree);
}
