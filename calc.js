// Safe arithmetic evaluator: the server (not the AI) computes every number in the Calculations section.
const MATH = new Set(Object.getOwnPropertyNames(Math));
function calc(expr, scope) {
  expr = String(expr || '');
  if (!expr.trim() || !/^[0-9A-Za-z_+\-*/().,\s^]*$/.test(expr)) throw new Error('unsupported characters in "' + expr + '"');
  const e = expr.replace(/\bln\(/g, 'log(').replace(/\^/g, '**');
  const ids = e.replace(/(?<![A-Za-z_\d.])(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/gi, '0').match(/[A-Za-z_]\w*/g) || [];
  for (const id of ids) if (!Object.prototype.hasOwnProperty.call(scope, id) && !MATH.has(id)) throw new Error('unknown name "' + id + '" in "' + expr + '"');
  const v = new Function('S', 'with(Math){with(S){return (' + e + ')}}')(scope);
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error('"' + expr + '" is not a finite number');
  return v;
}
module.exports = { calc };
