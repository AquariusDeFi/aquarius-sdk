// Match bundlers that resolve the Node buffer import to the browser polyfill.
export function resolve(specifier, context, nextResolve) {
  return nextResolve(specifier === "buffer" ? "buffer/index.js" : specifier, context);
}
