// lib/ui.js
import { supabase } from './supabase.js';

export async function initUI() {
  // 1. Inject Header and Footer
  try {
    const headerRes = await fetch('/components/header.html');
    const footerRes = await fetch('/components/footer.html');
    
    document.getElementById('header-placeholder').innerHTML = await headerRes.text();
    document.getElementById('footer-placeholder').innerHTML = await footerRes.text();
  } catch (err) {
    console.error("Failed to load components:", err);
  }

  // 2. Check Auth State
  const { data: { user } } = await supabase.auth.getUser();
  
  // If on a protected page and not logged in, redirect to login
  if (!user && !window.location.pathname.includes('login') && !window.location.pathname.includes('register')) {
    window.location.href = '/login.html';
    return;
  }

  // 3. Attach Logout Listener
  const logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      await supabase.auth.signOut();
      window.location.href = '/login.html';
    });
  }
}
