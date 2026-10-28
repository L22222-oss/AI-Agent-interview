export async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || 'GET',
    credentials: 'same-origin',
    headers: options.body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new CustomEvent('session-expired'));
    throw new Error(result.error || `请求失败 (${response.status})`);
  }
  return result;
}
