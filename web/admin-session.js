import './retry-hotfix.js';

let connected = false;
let initialized = false;

async function readResponse(response) {
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!response.ok) {
    const error = new Error(data?.error || `HTTP_${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

function emit() {
  window.dispatchEvent(new CustomEvent('orchestrator:admin-session', {
    detail: { connected, initialized }
  }));
}

export function isAdminConnected() {
  return connected;
}

export function isAdminSessionInitialized() {
  return initialized;
}

export async function refreshAdminSession() {
  try {
    const data = await readResponse(await fetch('/api/admin/session', {
      method: 'GET',
      headers: { accept: 'application/json' },
      credentials: 'same-origin'
    }));
    connected = Boolean(data?.connected);
  } catch {
    connected = false;
  } finally {
    initialized = true;
    emit();
  }
  return connected;
}

export async function connectAdmin(key) {
  const credential = String(key || '').trim();
  if (!credential) throw new Error('ADMIN_KEY_REQUIRED');
  const data = await readResponse(await fetch('/api/admin/session', {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'x-admin-api-key': credential
    },
    credentials: 'same-origin'
  }));
  connected = Boolean(data?.connected);
  initialized = true;
  emit();
  return data;
}

export async function disconnectAdmin() {
  const data = await readResponse(await fetch('/api/admin/session', {
    method: 'DELETE',
    headers: { accept: 'application/json' },
    credentials: 'same-origin'
  }));
  connected = false;
  initialized = true;
  emit();
  return data;
}

export async function adminApi(path, options = {}) {
  if (!initialized) await refreshAdminSession();
  if (!connected) throw Object.assign(new Error('ADMIN_SESSION_REQUIRED'), { status: 401 });
  const headers = new Headers(options.headers || {});
  headers.set('accept', 'application/json');
  if (options.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  try {
    return await readResponse(await fetch(path, {
      ...options,
      headers,
      credentials: 'same-origin'
    }));
  } catch (error) {
    if (error.status === 401) {
      connected = false;
      initialized = true;
      emit();
    }
    throw error;
  }
}

export const adminSessionReady = refreshAdminSession();
