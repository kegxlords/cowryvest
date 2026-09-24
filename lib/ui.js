// lib/ui.js
import { supabase } from './supabase.js';
import { formatMoney } from './format.js';

/* =========================================
   ROUTE CONFIG
========================================= */

const PUBLIC_PATHS = [
  '/',
  '/index.html',
  '/register.html',
  '/forgot-password.html',
  '/reset-password.html',
  '/login.html'
];

/* =========================================
   MAIN INIT (all pages)
========================================= */

export async function initUI() {
  await injectComponents();

  const { data: { user } } = await supabase.auth.getUser();
  const currentPath = window.location.pathname;
  const isPublicPage = PUBLIC_PATHS.includes(currentPath);

  if (!user && !isPublicPage) {
    window.location.href = '/';
    return { user: null, profile: null };
  }

  if (user && isPublicPage) {
    window.location.href = '/dashboard.html';
    return { user, profile: null };
  }

  let profile = null;
  if (user) {
    profile = await loadProfile(user);
  }

  buildNavigation(user, profile, currentPath);
  setupBalanceChip(profile);
  setupMobileMenu(user, profile, currentPath);
  setupFloatingFooter(user, currentPath);

  return { user, profile };
}

/* =========================================
   ADMIN INIT (admin pages)
========================================= */

export async function initAdminUI() {
  const ctx = await initUI();

  if (!ctx.user) return ctx;

  let role = ctx.profile?.role;

  // Verify role via server API (service role, bypasses RLS) if client read missed it
  if (role !== 'admin') {
    const apiProfile = await fetchProfileViaApi();
    role = apiProfile?.role || null;
  }

  if (role !== 'admin') {
    alert('Admin access required.');
    window.location.href = '/dashboard.html';
    return ctx;
  }

  return ctx;
}

/* =========================================
   PROFILE LOADING (client + API fallback)
========================================= */

async function loadProfile(user) {
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, role, full_name, email, referral_code, main_balance, frozen_balance')
      .eq('id', user.id)
      .maybeSingle();

    if (!error && data) return data;
  } catch (err) {
    console.warn('Client profile read failed:', err);
  }

  return await fetchProfileViaApi();
}

export async function fetchProfileViaApi() {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return null;

    const res = await fetch('/api/user?action=profile', {
      headers: { 'Authorization': `Bearer ${session.access_token}` }
    });

    if (!res.ok) return null;

    const result = await res.json();
    return result.profile || null;
  } catch (err) {
    console.warn('API profile read failed:', err);
    return null;
  }
}

/* =========================================
   SHARED COMPONENT INJECTION
========================================= */

async function injectComponents() {
  try {
    const headerRes = await fetch('/components/header.html');
    const footerRes = await fetch('/components/footer.html');

    const headerPlaceholder = document.getElementById('header-placeholder');
    const footerPlaceholder = document.getElementById('footer-placeholder');

    if (headerPlaceholder) headerPlaceholder.innerHTML = await headerRes.text();
    if (footerPlaceholder) footerPlaceholder.innerHTML = await footerRes.text();
  } catch (err) {
    console.error('Failed to load shared components:', err);
  }
}

/* =========================================
   NAVIGATION
========================================= */

function getNavLinks(profile) {
  const links = [
    { href: '/dashboard.html', label: 'Dashboard' },
    { href: '/market.html', label: 'Market' },
    { href: '/investments.html', label: 'Portfolio' },
    { href: '/stake.html', label: 'Stake' },
    { href: '/deposit.html', label: 'Deposit' },
    { href: '/withdraw.html', label: 'Withdraw' },
    { href: '/referral.html', label: 'Referrals' },
    { href: '/transaction-history.html', label: 'History' }
  ];

  if (profile?.role === 'admin') {
    links.push({ href: '/admin/index.html', label: 'Admin' });
  }

  return links;
}

function buildNavigation(user, profile, currentPath) {
  const mainNav = document.getElementById('mainNav');
  const authActions = document.getElementById('authActions');

  if (!mainNav || !authActions) return;

  if (!user) {
    mainNav.innerHTML = `
      <a href="/" class="nav-link ${currentPath === '/' || currentPath === '/index.html' ? 'active' : ''}">Login</a>
      <a href="/register.html" class="nav-link ${currentPath === '/register.html' ? 'active' : ''}">Register</a>
    `;
    authActions.innerHTML = '';
    return;
  }

  mainNav.innerHTML = getNavLinks(profile)
    .map(link => `
      <a href="${link.href}" class="nav-link ${currentPath === link.href ? 'active' : ''}">
        ${link.label}
      </a>
    `)
    .join('');

  const initials = getInitials(profile?.full_name);

  authActions.innerHTML = `
    <a href="/profile.html" class="profile-chip" title="View profile">
      <span class="profile-avatar">${escapeHtml(initials)}</span>
      <span class="profile-name">${escapeHtml(profile?.full_name || 'Profile')}</span>
    </a>

    <button class="icon-btn" id="logoutBtn" title="Logout" aria-label="Logout">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path>
        <path d="M16 17l5-5-5-5"></path>
        <path d="M21 12H9"></path>
      </svg>
    </button>
  `;

  document.getElementById('logoutBtn')?.addEventListener('click', async () => {
    await supabase.auth.signOut();
    window.location.href = '/';
  });
}

/* =========================================
   HEADER BALANCE CHIP
========================================= */

function setupBalanceChip(profile) {
  const chip = document.getElementById('balanceChip');
  if (!chip) return;

  if (!profile) {
    chip.classList.add('hidden');
    return;
  }

  chip.classList.remove('hidden');
  chip.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"></path>
      <path d="M3 5v14a2 2 0 0 0 2 2h16v-5"></path>
      <path d="M18 12a2 2 0 0 0 0 4h4v-4Z"></path>
    </svg>
    <span>${formatMoney(profile.main_balance)}</span>
  `;
}

export function updateBalanceChip(mainBalance) {
  const chip = document.getElementById('balanceChip');
  if (!chip) return;

  const span = chip.querySelector('span');
  if (span) span.textContent = formatMoney(mainBalance);
}

/* =========================================
   MOBILE HAMBURGER MENU
========================================= */

function setupMobileMenu(user, profile, currentPath) {
  const toggle = document.getElementById('menuToggle');
  const menu = document.getElementById('mobileMenu');

  if (!toggle || !menu) return;

  const links = user
    ? getNavLinks(profile)
    : [
        { href: '/', label: 'Login' },
        { href: '/register.html', label: 'Register' }
      ];

  menu.innerHTML = links
    .map(link => `
      <a href="${link.href}" class="mobile-link ${currentPath === link.href ? 'active' : ''}">
        ${link.label}
      </a>
    `)
    .join('');

  toggle.addEventListener('click', () => {
    menu.classList.toggle('open');
    toggle.classList.toggle('open');
  });

  menu.addEventListener('click', (e) => {
    if (e.target.closest('a')) {
      menu.classList.remove('open');
      toggle.classList.remove('open');
    }
  });
}

/* =========================================
   FLOATING MOBILE FOOTER
========================================= */

function setupFloatingFooter(user, currentPath) {
  const footerPlaceholder = document.getElementById('footer-placeholder');

  const isPublicPage = PUBLIC_PATHS.includes(currentPath);
  const isAdminPage = currentPath.startsWith('/admin');

  if (!user || isPublicPage || isAdminPage) {
    if (footerPlaceholder) footerPlaceholder.innerHTML = '';
    document.body.classList.remove('has-floating-nav');
    return;
  }

  document.body.classList.add('has-floating-nav');

  const footerLinks = document.querySelectorAll('.mobile-floating-nav a');

  footerLinks.forEach(link => {
    const href = link.getAttribute('href');

    const isActive =
      currentPath === href ||
      (href === '/dashboard.html' && currentPath === '/');

    link.classList.toggle('active', isActive);

    if (isActive) {
      link.setAttribute('aria-current', 'page');
    } else {
      link.removeAttribute('aria-current');
    }
  });
}

/* =========================================
   HELPERS
========================================= */

function getInitials(name) {
  return String(name || 'C')
    .trim()
    .split(' ')
    .map(part => part[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
