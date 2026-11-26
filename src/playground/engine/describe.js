// Bounded text for console arguments and thrown values crossing a sandbox:
// objects show at most 50 own enumerable keys and 100 array items, three
// levels deep, cycles print as [Circular], and output stops at `limit`
// characters. The runner Worker imports this module; the preview frame
// inlines its source, so it imports nothing.

export function describe(values, limit = 8192) {
  let out = '';
  const seen = new Set();
  const write = text => {
    if (out.length < limit) out += text.slice(0, limit - out.length);
  };
  const visit = (value, depth) => {
    if (out.length >= limit) return;
    if (typeof value === 'string') return write(depth === 0 ? value : JSON.stringify(value));
    if (typeof value === 'bigint') return write(`${value}n`);
    if (value === null || typeof value !== 'object' && typeof value !== 'function') return write(String(value));
    if (typeof value === 'function') return write(`[Function ${value.name || 'anonymous'}]`);
    if (value instanceof Error) {
      write(`${value.name}: ${value.message}`);
      if ('code' in value && typeof value.code === 'string') write(` (${value.code})`);
      return;
    }
    if (seen.has(value)) return write('[Circular]');
    if (depth >= 3) return write(Array.isArray(value) ? '[Array]' : '[Object]');
    seen.add(value);
    if (ArrayBuffer.isView(value)) {
      write(`${value.constructor.name}(${value.byteLength})`);
    } else if (Array.isArray(value)) {
      write('[');
      value.slice(0, 100).forEach((item, index) => { if (index) write(', '); visit(item, depth + 1); });
      if (value.length > 100) write(', …');
      write(']');
    } else {
      const name = Object.getPrototypeOf(value)?.constructor?.name;
      if (name && name !== 'Object') write(`${name} `);
      write('{');
      Object.keys(value).slice(0, 50).forEach((key, index) => {
        if (index) write(', ');
        write(`${key}: `);
        let item;
        try { item = value[key]; } catch (error) { item = error; }
        visit(item, depth + 1);
      });
      write('}');
    }
    seen.delete(value);
  };
  values.forEach((value, index) => {
    if (index) write(' ');
    visit(value, 0);
  });
  return out;
}
