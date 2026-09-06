export function isAuthorized(request, env) {
  const expected = String(env.ORCHESTRATOR_API_KEY || '');
  if (!expected) return false;
  return request.headers.get('x-hub-api-key') === expected;
}

export function requireAuthorized(request, env) {
  if (!isAuthorized(request, env)) {
    const error = new Error('UNAUTHORIZED');
    error.status = 401;
    throw error;
  }
}
