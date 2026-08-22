/** Signed-in identity chip with a dropdown, shared by the vote and control pages. */

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const CHEVRON =
  '<svg class="chev" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" ' +
  'stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';

function avatar(me) {
  const name = me.displayName || me.login;
  return me.avatar
    ? `<img class="avatar" src="${esc(me.avatar)}" alt="">`
    : `<span class="avatar fallback">${esc(name.slice(0, 1).toUpperCase())}</span>`;
}

/**
 * `links` are rendered inside the menu as [{ href, label, external }].
 */
export function profileHtml(me, links = []) {
  const name = me.displayName || me.login;
  return `
    <div class="profile" id="profile">
      <button class="profile-btn" id="profile-btn" aria-haspopup="true" aria-expanded="false">
        ${avatar(me)}
        <span class="pname">${esc(name)}</span>
        ${CHEVRON}
      </button>
      <div class="profile-menu" id="profile-menu" hidden role="menu">
        <div class="menu-head">
          Signed in as <b>${esc(name)}</b>
          ${me.isBroadcaster ? '<span class="tag">Streamer</span>' : ''}
          ${!me.isBroadcaster && me.canControl ? '<span class="tag">Admin</span>' : ''}
        </div>
        ${links.length
          ? `<div class="menu-links">${links
              .map(
                (l) =>
                  `<a role="menuitem" href="${esc(l.href)}"${
                    l.external ? ' target="_blank" rel="noopener"' : ''
                  }>${esc(l.label)}${l.external ? ' <span aria-hidden="true">&#8599;</span>' : ''}</a>`,
              )
              .join('')}</div>`
          : ''}
        <button class="btn" id="logout" role="menuitem">Sign out</button>
      </div>
    </div>`;
}

// Registered once for the page's lifetime: wireProfile runs on every re-render,
// and adding document listeners there would stack a new pair each time.
let dismissBound = false;

function bindDismiss() {
  if (dismissBound) return;
  dismissBound = true;
  const close = () => {
    const menu = document.getElementById('profile-menu');
    const btn = document.getElementById('profile-btn');
    const root = document.getElementById('profile');
    if (!menu || menu.hidden) return;
    menu.hidden = true;
    btn?.setAttribute('aria-expanded', 'false');
    root?.classList.remove('open');
  };
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#profile')) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });
}

/** Call after the markup is in the DOM. `onSignOut` runs when Sign out is pressed. */
export function wireProfile(onSignOut) {
  const root = document.getElementById('profile');
  const btn = document.getElementById('profile-btn');
  const menu = document.getElementById('profile-menu');
  if (!root || !btn || !menu) return;

  bindDismiss();

  btn.onclick = (e) => {
    e.stopPropagation();
    const open = menu.hidden;
    menu.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    root.classList.toggle('open', open);
  };

  document.getElementById('logout').onclick = onSignOut;
}
