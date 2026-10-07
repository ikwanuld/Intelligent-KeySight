import { h, clear } from './dom.js';
import { api } from '../api/client.js';
import { auth, deniedMessage } from '../auth/auth.js';
import { authMode } from '../config.js';

export function loginScreen(root, ctx, { error } = {}) {
  const errBox = h('div', { class: 'notice bad', hidden: !error, role: 'alert' });
  const showError = (code) => {
    clear(errBox).append(h('h2', null, ['NOT_WHITELISTED', 'DOMAIN_NOT_ALLOWED'].includes(code) ? 'Access denied' : code === 'NO_STATION' ? 'No operational access' : 'Cannot sign in'),
      h('p', null, deniedMessage(code)));
    errBox.hidden = false;
  };
  if (error) showError(error);

  const page = h('div', { class: 'page' },
    h('h1', null, 'ULD Scanner'),
    h('p', { class: 'muted' }, 'Count ULDs by pointing the camera at the number.'),
    errBox);

  if (api.enabled && authMode() === 'email') {
    const email = h('input', { type: 'email', id: 'email', autocomplete: 'email', inputMode: 'email', placeholder: 'name@company.com' });
    const btn = h('button', { class: 'btn primary block' }, 'Sign in');
    const go = async () => {
      btn.disabled = true; errBox.hidden = true;
      const r = await auth.emailLogin(email.value);
      btn.disabled = false;
      if (r.error) return showError(r.error);
      ctx.afterLogin();
    };
    btn.onclick = go;
    email.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    page.append(
      h('div', { class: 'field' }, h('label', { for: 'email' }, 'Work e-mail'), email), btn,
      h('p', { class: 'small muted' }, 'Access is given by your administrator.'));
  } else if (api.enabled) {
    page.append(
      h('button', { class: 'btn primary block', onclick: () => auth.startLogin('google') }, 'Sign in with Google'),
      h('button', { class: 'btn block', onclick: () => auth.startLogin('microsoft') }, 'Sign in with Microsoft'),
      h('p', { class: 'small muted' }, 'Use your company account. Access is given by your administrator.'));
  } else {
    const email = h('input', { type: 'email', id: 'email', autocomplete: 'email', inputMode: 'email', placeholder: 'name@company.com' });
    const go = async () => {
      const r = await auth.demoLogin(email.value);
      if (r.error) return showError(r.error);
      ctx.afterLogin();
    };
    email.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    page.append(
      h('p', { class: 'notice' }, 'Demo mode. No server is connected: scans stay on this device and sign-in is not verified.'),
      h('div', { class: 'field' }, h('label', { for: 'email' }, 'Work e-mail'), email),
      h('button', { class: 'btn primary block', onclick: go }, 'Continue'));
  }
  clear(root).append(page);
}
