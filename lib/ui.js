// lib/ui.js
import { supabase } from './supabase.js';

const PUBLIC_PATHS = [
  '/',
  '/index.html',
  '/register.html',
  '/forgot-password.html',
  '/reset-password.html',
  '/login.html'
];

export async function initUI() {
  // 1. Inject shared header and footer
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

  // 2. Get current auth user
  const { data: { user } } = await supabase.auth.getUser();

  const currentPath = window.location.pathname;
  const isPublicPage = PUBLIC_PATHS.includes(currentPath);

  // 3. Redirect rules
  if (!user && !isPublicPage) {
    window.location.href = '/';
    return { user: null, profile: null };
  }

  if (user && isPublicPage) {
    window.location.href = '/dashboard.html';
    return { user, profile: null };
  }

  // 4. Fetch profile if logged in
  let profile = null;
  if (user) {
    const { data } = await supabase
      .from('profiles')
      .select('role, full_name, referral_code')
      .eq('id', user.id)
      .maybeSingle();

    profile = data;
  }

  // 5. Build navigation
  buildNavigation(user, profile);

  // 6. Setup floating footer
  setupFloatingFooter(user, currentPath);

  return { user, profile };
}

export async function initAdminUI() {
  const ctx = await initUI();

  if (!ctx.user) {
    return ctx;
  }

  if (ctx.profile?.role !== 'admin') {
    alert('Admin access required.');
    window.location.href = '/dashboard.html';
    return ctx;
  }

  return ctx;
}

function buildNavigation(user, profile) {
  const mainNav = document.getElementById('mainNav');
  const authActions = document.getElementById('authActions');

  if (!mainNav || !authActions) return;

  mainNav.innerHTML = '';
  authActions.innerHTML = '';

  if (!user) {
    mainNav.innerHTML = `
      <a href="/">Login</a>
      <a href="/register.html">Register</a>
    `;
    return;
  }

  const links = [
    { href: '/dashboard.html', label: 'Dashboard' },
    { href: '/market.html', label: 'Market' },
    { href: '/investments.html', label: 'Portfolio' },
    { href: '/deposit.html', label: 'Deposit' },
    { href: '/withdraw.html', label: 'Withdraw' },
    { href: '/referral.html', label: 'Referrals' },
    { href: '/transaction-history.html', label: 'History' }
  ];

  if (profile?.role === 'admin') {
    links.push({ href: '/admin/index.html', label: 'Admin' });
  }

  mainNav.innerHTML = links
    .map(link => `<a href="${link.href}">${link.label}</a>`)
    .join('');

  authActions.innerHTML = `
  <a href="/profile.html" class="btn btn-small btn-secondary">Profile</a>
  <button class="btn btn-small btn-danger" id="logoutBtn">Logout</button>
`;

  const logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      await supabase.auth.signOut();
      window.location.href = '/';
    });
  }
}

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
