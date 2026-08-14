(function () {
  var yearEl = document.getElementById('year');
  if (yearEl) yearEl.textContent = new Date().getFullYear();
})();

(function () {
  var toggle = document.querySelector('.nav-toggle');
  var links = document.querySelector('.nav-links');

  if (toggle && links) {
    toggle.addEventListener('click', function () {
      var isOpen = links.classList.toggle('open');
      toggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    });
  }
})();

// Drop missing portfolio screenshots so the letter placeholder shows instead of a broken image.
document.addEventListener(
  'error',
  function (e) {
    var el = e.target;
    if (el && el.tagName === 'IMG' && el.parentElement && el.parentElement.classList.contains('work-thumb')) {
      el.remove();
    }
  },
  true
);

(function () {
  var form = document.getElementById('request-form');
  if (!form) return;

  // The site is static (Netlify); the form posts to the Railway API backend.
  // Using the Railway-generated domain temporarily while api.getwebsiteonline.com's
  // TLS certificate finishes provisioning.
  var API_BASE = 'https://llmdirector-com-production.up.railway.app';

  var statusBox = document.getElementById('form-status');
  var submitBtn = form.querySelector('.submit-btn');

  function showStatus(message, type) {
    statusBox.textContent = message;
    statusBox.className = 'form-status show ' + type;
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();

    var data = {
      name: form.name.value.trim(),
      email: form.email.value.trim(),
      business: form.business.value.trim(),
      phone: form.phone.value.trim(),
      pages: form.pages.value,
      details: form.details.value.trim(),
      website: form.website.value, // honeypot
    };

    if (!data.name || !data.email || !data.business || !data.details) {
      showStatus('Please fill in all required fields.', 'error');
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Sending...';

    fetch(API_BASE + '/api/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
      .then(function (res) {
        return res.json().then(function (body) {
          return { ok: res.ok, body: body };
        });
      })
      .then(function (result) {
        if (result.ok && result.body.ok) {
          window.location.href = '/thank-you.html';
          return;
        }
        showStatus(result.body.error || 'Something went wrong. Please try again.', 'error');
        submitBtn.disabled = false;
        submitBtn.textContent = 'Request My Website';
      })
      .catch(function () {
        showStatus('Network error. Please check your connection and try again.', 'error');
        submitBtn.disabled = false;
        submitBtn.textContent = 'Request My Website';
      });
  });
})();
