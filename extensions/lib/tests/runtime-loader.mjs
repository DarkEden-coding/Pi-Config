// Use the same Pi installation as the transport and extension runtime.
import { runtimeModuleUrl } from '../cliproxy/runtime.ts';
export function resolve(specifier, context, nextResolve) {
  if (specifier === 'typebox' || /^@earendil-works\/pi-(coding-agent|ai|tui)(\/|$)/.test(specifier)) {
    return { url: runtimeModuleUrl(specifier), shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
