/* ============================================================
   dharunvincent.com — Shared JavaScript
   All pages load this file.
   Handles: navbar scroll, reveal animations, custom cursor,
            hamburger menu, footer year, email injection.
   ============================================================ */

(function () {
  'use strict';

  /* ── Footer year ─────────────────────────────────────────── */
  const yearEl = document.getElementById('year');
  if (yearEl) yearEl.textContent = new Date().getFullYear();

  /* ── Navbar: glass effect on scroll ──────────────────────── */
  const navInner = document.getElementById('nav-inner');
  if (navInner) {
    window.addEventListener('scroll', () => {
      navInner.classList.toggle('scrolled', window.scrollY > 40);
    }, { passive: true });
  }

  /* ── Navbar: active link highlight (homepage sections only) ── */
  const navLinks = document.querySelectorAll('.nav-links a[href^="#"]');
  if (navLinks.length) {
    const sections = document.querySelectorAll('main section[id]');
    sections.forEach(s => {
      new IntersectionObserver(entries => {
        entries.forEach(e => {
          if (e.isIntersecting) {
            navLinks.forEach(a =>
              a.classList.toggle('active', a.getAttribute('href') === '#' + e.target.id)
            );
          }
        });
      }, { rootMargin: '-40% 0px -55% 0px' }).observe(s);
    });
  }

  /* ── Reveal on scroll ─────────────────────────────────────── */
  // Uses IntersectionObserver for performance — no scroll listener
  const ro = new IntersectionObserver(entries => {
    entries.forEach(e => {
      if (e.isIntersecting) {
        e.target.classList.add('visible');
        ro.unobserve(e.target); // stop watching after reveal
      }
    });
  }, { rootMargin: '-60px 0px' });
  document.querySelectorAll('.reveal').forEach(el => ro.observe(el));

  /* ── Hero parallax (homepage only) ───────────────────────── */
  const heroPhoto = document.getElementById('hero-photo');
  if (heroPhoto) {
    window.addEventListener('scroll', () => {
      // Only run while hero is in viewport — saves GPU
      if (window.scrollY < window.innerHeight) {
        heroPhoto.style.transform = `translateY(${window.scrollY * 0.25}px)`;
      }
    }, { passive: true });
  }

  /* ── Custom cursor (mouse devices only) ──────────────────── */
  // Three-layer detection to avoid activating on touch/tablet
  const hasFinePointer = window.matchMedia('(pointer: fine)').matches;
  const hasHover       = window.matchMedia('(hover: hover)').matches;
  const hasTouch       = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
  const isMobileUA     = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|Tablet/i.test(navigator.userAgent);
  const isRealMouse    = hasFinePointer && hasHover && !isMobileUA;

  if (isRealMouse) {
    document.body.classList.add('has-cursor');

    // Hide native cursor immediately
    document.documentElement.style.cursor = 'none';
    document.body.style.cursor = 'none';

    const dot  = document.getElementById('cursor-dot');
    const ring = document.getElementById('cursor-ring');

    if (dot && ring) {
      let rx = 0, ry = 0, animId;

      // Activate cursor only after first mouse move — prevents top-left flash
      document.addEventListener('mousemove', function activate() {
        document.body.classList.add('cursor-active');
        document.removeEventListener('mousemove', activate);
      }, { once: true });

      document.addEventListener('mousemove', e => {
        const x = e.clientX, y = e.clientY;
        // Dot follows instantly
        dot.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
        // Ring follows with smooth lerp animation
        cancelAnimationFrame(animId);
        (function lerp() {
          rx += (x - rx) * 0.13;
          ry += (y - ry) * 0.13;
          ring.style.transform = `translate(${rx}px, ${ry}px) translate(-50%, -50%)`;
          if (Math.abs(x - rx) > 0.1 || Math.abs(y - ry) > 0.1) {
            animId = requestAnimationFrame(lerp);
          }
        })();
      });

      // Hide cursor when mouse leaves the window
      document.addEventListener('mouseleave', () => document.body.classList.remove('cursor-active'));
      document.addEventListener('mouseenter', () => document.body.classList.add('cursor-active'));

      // Expand ring on interactive elements
      document.querySelectorAll('a, button').forEach(el => {
        el.addEventListener('mouseenter', () => document.body.classList.add('cursor-hover'));
        el.addEventListener('mouseleave', () => document.body.classList.remove('cursor-hover'));
      });
    }
  }

  /* ── Hamburger menu (mobile) ──────────────────────────────── */
  const hamburger = document.getElementById('hamburger');
  const mobileNav = document.getElementById('mobile-nav');
  const backdrop  = document.getElementById('mobile-nav-backdrop');

  function openMobileNav() {
    if (!hamburger || !mobileNav || !backdrop) return;
    hamburger.classList.add('open');
    hamburger.setAttribute('aria-expanded', 'true');
    backdrop.classList.add('open');
    mobileNav.style.display = 'block';
    // Double rAF forces browser to paint display:block before transition starts
    requestAnimationFrame(() => requestAnimationFrame(() => mobileNav.classList.add('open')));
  }

  function closeMobileNav() {
    if (!hamburger || !mobileNav || !backdrop) return;
    hamburger.classList.remove('open');
    hamburger.setAttribute('aria-expanded', 'false');
    mobileNav.classList.remove('open');
    backdrop.classList.remove('open');
    // Hide element after CSS transition completes (280ms)
    setTimeout(() => {
      if (!mobileNav.classList.contains('open')) mobileNav.style.display = 'none';
    }, 280);
  }

  // Expose closeMobileNav globally so inline onclick in HTML can call it
  window.closeMobileNav = closeMobileNav;

  if (hamburger) {
    hamburger.addEventListener('click', e => {
      e.stopPropagation();
      hamburger.classList.contains('open') ? closeMobileNav() : openMobileNav();
    });
  }

  // Close on Escape key
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeMobileNav(); });

  /* ── Email injection (Cloudflare-proof) ───────────────────── */
  // Email is assembled at runtime so crawlers can't harvest it
  (function () {
    const u = 'dharun';
    const d = 'dharunvincent' + '.' + 'com';
    const e = u + '@' + d;
    const mailto = 'mail' + 'to:' + e;

    const linkEl = document.getElementById('contact-email-link');
    if (linkEl) linkEl.href = mailto;

    const textEl = document.getElementById('contact-email-text');
    if (textEl) textEl.textContent = e;

    const mobEl = document.getElementById('mobile-email-link');
    if (mobEl) mobEl.href = mailto;
  })();

  /* ── Hero photo: progressive blur on scroll ───────────────── */
  // Mobile only. As user scrolls down the first screen, the hero
  // photo blurs and darkens progressively — creating a cinematic
  // transition from the personal intro into the content below.
  // Uses requestAnimationFrame for smooth 60fps performance.
  (function () {
    const photo = document.getElementById('hero-photo');
    // Only run on homepage (photo element exists) and mobile screens
    if (!photo || window.innerWidth > 767) return;

    // Create a JS-controlled overlay div for the darkening effect
    // (separate from the CSS ::after overlay which handles the gradient)
    const blurOverlay = document.createElement('div');
    blurOverlay.id = 'hero-blur-overlay';
    blurOverlay.style.cssText = [
      'position:absolute',
      'inset:0',
      'z-index:1',
      'background:rgba(0,0,0,0)',
      'pointer-events:none',
      'transition:none', // we control this via JS for smoothness
    ].join(';');
    photo.appendChild(blurOverlay);

    let ticking = false;

    function applyBlur() {
      const scrollY   = window.scrollY;
      const screenH   = window.innerHeight;
      // Progress: 0 at top, 1 when user has scrolled one full screen
      const progress  = Math.min(scrollY / screenH, 1);

      // Blur: 0px → 14px
      const blurPx    = Math.round(progress * 14 * 10) / 10;
      // Overlay darkness: 0 → 0.65 opacity
      const overlayOp = Math.round(progress * 0.65 * 100) / 100;

      photo.style.filter        = `blur(${blurPx}px)`;
      blurOverlay.style.background = `rgba(0,0,0,${overlayOp})`;

      ticking = false;
    }

    window.addEventListener('scroll', () => {
      if (!ticking) {
        requestAnimationFrame(applyBlur);
        ticking = true;
      }
    }, { passive: true });

    // Run once on load in case page is already scrolled (e.g. refresh mid-page)
    applyBlur();
  })();

})();
