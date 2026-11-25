const view = document.getElementById('view');
const VIEWER = view?.dataset.viewer || '';
const ROLE = view?.dataset.role || '';
const navLinks = Array.from(document.querySelectorAll('[data-route]'));

const esc = value => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}[char]));

const formatDate = value => {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
};

const api = async (path, options = {}) => {
  const response = await fetch(path, {
    ...options,
    headers: { Accept: 'application/json', ...(options.headers || {}) },
  });
  if (response.status === 401) {
    location.href = '/login';
    throw new Error('unauthorized');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'request failed');
  return data;
};

const copy = async (value, button) => {
  try {
    await navigator.clipboard.writeText(value);
    const label = button.textContent;
    button.textContent = 'copied!';
    setTimeout(() => { button.textContent = label; }, 1000);
  } catch {
    // Clipboard access can be denied.
  }
};

const routeInfo = () => {
  const path = location.pathname.replace(/\/+$/, '');
  if (!path.startsWith('/dashboard')) return { view: 'links' };

  const parts = path.slice('/dashboard'.length).split('/').filter(Boolean);
  if (parts[0] === 'account') return { view: 'account' };
  if (parts[0] === 'invites') return { view: 'invites' };
  if (parts[0] === 'users') {
    if (parts[1]) return { view: 'user', username: decodeURIComponent(parts[1]) };
    return { view: 'users' };
  }
  return { view: 'links' };
};

const navigate = (path, { replace = false } = {}) => {
  if (replace) history.replaceState({}, '', path);
  else history.pushState({}, '', path);
  render();
};

const setActive = (path) => {
  for (const link of navLinks) {
    const target = link.dataset.route;
    link.classList.toggle(
      'active',
      path === target || path.startsWith(target + '/'),
    );
  }
};

const empty = text => `<p class="muted">${esc(text)}</p>`;

const proxyRow = (proxy, { admin = false } = {}) => `
  <div class="row" data-proxy-id="${esc(proxy.id)}">
    <div class="row-main">
      <a href="${esc(proxy.shortUrl)}" target="_blank" rel="noopener">${esc(proxy.shortUrl)}</a>
      <code>${esc(proxy.url)}</code>
    </div>
    <div class="row-meta">
      ${proxy.isCdn ? 'production' : 'development'}${proxy.createdAt ? ' · ' + esc(formatDate(proxy.createdAt)) : ''}
    </div>
    <div class="row-actions">
      <button class="btn" data-copy>copy</button>
      ${admin ? '' : '<button class="btn" data-purge>purge</button><button class="btn danger" data-delete>delete</button>'}
    </div>
  </div>
`;

const bindProxyActions = (container, proxies, { reload, admin = false }) => {
  const byId = new Map(proxies.map((proxy) => [proxy.id, proxy]));

  container.addEventListener('click', async (event) => {
    const row = event.target.closest('[data-proxy-id]');
    if (!row) return;
    const proxy = byId.get(row.dataset.proxyId);
    if (!proxy) return;

    if (event.target.matches('[data-copy]')) {
      await copy(proxy.shortUrl, event.target);
      return;
    }

    if (admin) return;

    if (event.target.matches('[data-purge]')) {
      const button = event.target;
      button.disabled = true;
      try {
        const response = await fetch('/purge?' + new URLSearchParams({ url: proxy.shortUrl }), {
          method: 'DELETE',
        });
        button.textContent = response.ok ? 'purged' : 'failed';
      } catch {
        button.textContent = 'failed';
      }
      setTimeout(() => {
        button.textContent = 'purge';
        button.disabled = false;
      }, 1500);
      return;
    }

    if (event.target.matches('[data-delete]')) {
      if (!confirm('Delete ' + proxy.shortUrl + '?')) return;
      event.target.disabled = true;
      await api('/api/proxies/' + encodeURIComponent(proxy.id), { method: 'DELETE' });
      reload();
    }
  });
};

const renderLinks = async () => {
  view.innerHTML = `
    <h1>Links</h1>
    <p class="lead">Signed in as ${esc(VIEWER)}. Short links can be opened without signing in.</p>

    <form id="create-form">
      <div class="create-box">
        <div class="create-row url-container">
          <input id="target" class="url" type="url" required
                 placeholder="Paste a GitHub, GitLab, Bitbucket, Gitea, Codeberg or this-instance URL">
          <select id="mode" title="Cache mode">
            <option value="cdn">production</option>
            <option value="dev">development</option>
          </select>
          <button type="submit" class="url-action-button">create</button>
        </div>
        <div class="create-custom">
          <span class="prefix">/s/</span>
          <input id="slug" class="url" placeholder="custom short name (blank = legacy URL)"
                 autocomplete="off" spellcheck="false" maxlength="64" pattern="[A-Za-z0-9_-]{2,64}">
        </div>
        <div id="create-result" class="create-result" hidden>
          <input id="short-url" class="url" readonly placeholder="Your short link">
          <button id="copy-short" class="url-action-button" type="button">copy</button>
        </div>
      </div>
    </form>

    <p id="create-error" class="error"></p>

    <h2>Your short links</h2>
    <div id="proxy-list">${empty('Loading…')}</div>
  `;

  const form = document.getElementById('create-form');
  const targetEl = document.getElementById('target');
  const slugEl = document.getElementById('slug');
  const modeEl = document.getElementById('mode');
  const errorEl = document.getElementById('create-error');
  const resultEl = document.getElementById('create-result');
  const shortEl = document.getElementById('short-url');
  const copyShort = document.getElementById('copy-short');
  const listEl = document.getElementById('proxy-list');
  let proxies = [];

  const resetResult = () => {
    resultEl.hidden = true;
    errorEl.textContent = '';
  };

  targetEl.addEventListener('input', resetResult);
  slugEl.addEventListener('input', resetResult);

  document.getElementById('create-result').addEventListener('click', (event) => {
    if (event.target === copyShort) copy(shortEl.value, copyShort);
  });

  const reload = async () => {
    try {
      const data = await api('/api/proxies');
      proxies = data.proxies || [];
      listEl.innerHTML = proxies.length
        ? proxies.map((proxy) => proxyRow(proxy)).join('')
        : empty('No short links yet.');
      bindProxyActions(listEl, proxies, { reload });
    } catch {
      listEl.innerHTML = empty('Could not load short links.');
    }
  };

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorEl.textContent = '';
    resultEl.hidden = true;

    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;

    try {
      const data = await api('/api/proxies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: targetEl.value.trim(),
          cdn: modeEl.value === 'cdn',
          slug: slugEl.value.trim() || undefined,
        }),
      });

      shortEl.value = data.shortUrl;
      resultEl.hidden = false;
      shortEl.focus();
      shortEl.select();
      targetEl.value = '';
      slugEl.value = '';
      reload();
    } catch (error) {
      errorEl.textContent = error.message;
    } finally {
      submit.disabled = false;
    }
  });

  await reload();
};

const renderAccount = () => {
  view.innerHTML = `
    <h1>Account</h1>
    <p class="lead">Your account and session.</p>

    <div class="card">
      <div>
        <strong>${esc(VIEWER)}</strong>
        <span class="role ${ROLE === 'admin' ? 'admin' : ''}">${esc(ROLE)}</span>
      </div>
      <div class="card-actions">
        <a class="btn" href="/dashboard">Dashboard</a>
        <a class="btn danger" href="/logout">Sign out</a>
      </div>
    </div>

    <h2>Public links</h2>
    <p class="muted">
      Your short links under <code>/s/</code> and proxied file URLs can be opened without signing in.
      The dashboard itself requires authentication.
    </p>

    <h2>Recovery codes</h2>
    <div class="card">
      <div>
        <strong>Account recovery</strong>
        <p class="muted" style="margin:.3em 0 0;">
          Regenerate your codes to revoke all old codes and create a new set.
        </p>
      </div>
      <div class="card-actions">
        <button class="btn danger" id="regenerate-codes" type="button">regenerate codes</button>
      </div>
    </div>
    <p class="muted" id="recovery-status"></p>
  `;

  const regenerate = document.getElementById('regenerate-codes');
  const recoveryStatus = document.getElementById('recovery-status');

  regenerate.addEventListener('click', async () => {
    if (!confirm('Revoke all existing recovery codes and generate a new set?')) return;

    regenerate.disabled = true;
    recoveryStatus.textContent = '';

    try {
      await api('/api/recovery-codes/regenerate', { method: 'POST' });
      location.href = '/recovery-codes';
    } catch (error) {
      recoveryStatus.textContent = error.message;
      regenerate.disabled = false;
    }
  });
};

const renderUsers = async () => {
  view.innerHTML = `
    <h1>Users</h1>
    <p class="lead">Registered accounts and their roles.</p>
    <div id="users">${empty('Loading…')}</div>
  `;

  const container = document.getElementById('users');

  try {
    const data = await api('/api/admin/users');
    const users = data.users || [];
    container.innerHTML = `
      <table>
        <thead>
          <tr><th>Username</th><th>Role</th><th>Created</th></tr>
        </thead>
        <tbody>
          ${users.map((user) => `
            <tr>
              <td><a data-route="/dashboard/users/${encodeURIComponent(user.username)}" href="/dashboard/users/${encodeURIComponent(user.username)}">${esc(user.username)}</a></td>
              <td><span class="role ${user.role === 'admin' ? 'admin' : ''}">${esc(user.role)}</span></td>
              <td class="muted">${esc(formatDate(user.createdAt))}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  } catch (error) {
    container.innerHTML = empty(error.message);
  }
};

const renderUserDetail = async (username) => {
  view.innerHTML = `
    <h1>/dashboard/users/${esc(username)}</h1>
    <p class="lead">Admin controls for this user.</p>
    <div id="user-detail">${empty('Loading…')}</div>
  `;

  const container = document.getElementById('user-detail');

  try {
    const data = await api('/api/admin/users/' + encodeURIComponent(username));
    const user = data.user;
    const proxies = data.proxies || [];

    container.innerHTML = `
      <div class="card">
        <div>
          <strong>${esc(user.username)}</strong>
          <span class="role ${user.role === 'admin' ? 'admin' : ''}">${esc(user.role)}</span>
        </div>
        <div class="card-actions">
          <label for="role-select" class="muted">Role</label>
          <select id="role-select">
            <option value="user" ${user.role === 'user' ? 'selected' : ''}>user</option>
            <option value="admin" ${user.role === 'admin' ? 'selected' : ''}>admin</option>
          </select>
          <button class="btn" id="role-save" type="button">save</button>
          <button class="btn danger" id="user-delete" type="button">delete</button>
          <a class="btn" data-route="/dashboard/users" href="/dashboard/users">back</a>
        </div>
      </div>

      <p class="error" id="admin-status"></p>

      <h2>Short links</h2>
      <div id="user-links">
        ${proxies.length
          ? proxies.map((proxy) => proxyRow(proxy, { admin: true })).join('')
          : empty('No short links yet.')}
      </div>
    `;

    const roleSelect = document.getElementById('role-select');
    const status = document.getElementById('admin-status');
    const linkList = document.getElementById('user-links');
    bindProxyActions(linkList, proxies, { reload: () => renderUserDetail(username), admin: true });

    document.getElementById('role-save').addEventListener('click', async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      status.textContent = '';
      try {
        await api('/api/admin/users/' + encodeURIComponent(username), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ role: roleSelect.value }),
        });
        status.textContent = 'saved';
        renderUserDetail(username);
      } catch (error) {
        status.textContent = error.message;
        button.disabled = false;
      }
    });

    document.getElementById('user-delete').addEventListener('click', async (event) => {
      if (!confirm('Delete user ' + username + ' and all their short links?')) return;
      const button = event.currentTarget;
      button.disabled = true;
      try {
        await api('/api/admin/users/' + encodeURIComponent(username), { method: 'DELETE' });
        navigate('/dashboard/users');
      } catch (error) {
        status.textContent = error.message;
        button.disabled = false;
      }
    });
  } catch (error) {
    container.innerHTML = empty(error.message);
  }
};

const renderInvites = async () => {
  view.innerHTML = `
    <h1>Invites</h1>
    <p class="lead">Create one-time registration links. Users can also enter a code at <a href="/register">/register</a>.</p>

    <div class="toolbar">
      <input id="invite-result" readonly placeholder="Create an invite to get a one-time registration URL">
      <button class="btn" id="invite-copy" type="button" disabled>copy</button>
      <button class="btn" id="invite-create" type="button">create invite</button>
    </div>

    <div id="invite-list" style="margin-top: 1.5em;">${empty('Loading…')}</div>
  `;

  const result = document.getElementById('invite-result');
  const copyButton = document.getElementById('invite-copy');
  const createButton = document.getElementById('invite-create');
  const list = document.getElementById('invite-list');

  const reload = async () => {
    try {
      const data = await api('/api/admin/invites');
      const invites = data.invites || [];
      list.innerHTML = invites.length
        ? `
          <table>
            <thead><tr><th>Created</th><th>Status</th><th>Used by</th><th></th></tr></thead>
            <tbody>
              ${invites.map((invite) => `
                <tr>
                  <td class="muted">${esc(formatDate(invite.createdAt))}</td>
                  <td class="${invite.usedAt ? 'muted' : ''}">${invite.usedAt ? 'used' : 'unused'}</td>
                  <td class="muted">${esc(invite.usedBy || '—')}</td>
                  <td>${invite.usedAt ? '' : `<button class="btn danger" data-revoke="${esc(invite.id)}" type="button">revoke</button>`}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        `
        : empty('No invites yet.');
    } catch (error) {
      list.innerHTML = empty(error.message);
    }
  };

  list.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-revoke]');
    if (!button) return;
    if (!confirm('Revoke this invite?')) return;
    button.disabled = true;
    try {
      await api('/api/admin/invites/' + encodeURIComponent(button.dataset.revoke), { method: 'DELETE' });
      reload();
    } catch {
      button.disabled = false;
    }
  });

  createButton.addEventListener('click', async () => {
    createButton.disabled = true;
    try {
      const data = await api('/api/admin/invites', { method: 'POST' });
      result.value = data.url;
      copyButton.disabled = false;
      result.focus();
      result.select();
      reload();
    } catch (error) {
      result.value = error.message;
    } finally {
      createButton.disabled = false;
    }
  });

  copyButton.addEventListener('click', () => copy(result.value, copyButton));

  await reload();
};

const render = async () => {
  const path = location.pathname.replace(/\/+$/, '') || '/dashboard';
  const route = routeInfo();
  const adminRoute = route.view === 'users' || route.view === 'invites' || route.view === 'user';

  if (adminRoute && ROLE !== 'admin') {
    history.replaceState({}, '', '/dashboard/links');
    render();
    return;
  }

  setActive(path);

  if (route.view === 'account') await renderAccount();
  else if (route.view === 'users') await renderUsers();
  else if (route.view === 'invites') await renderInvites();
  else if (route.view === 'user') await renderUserDetail(route.username);
  else await renderLinks();
};

document.addEventListener('click', (event) => {
  const link = event.target.closest('a[data-route]');
  if (!link) return;
  event.preventDefault();
  navigate(link.getAttribute('data-route'));
});

window.addEventListener('popstate', render);

if (location.pathname === '/dashboard' || location.pathname === '/dashboard/') {
  history.replaceState({}, '', '/dashboard/links');
}

render();
