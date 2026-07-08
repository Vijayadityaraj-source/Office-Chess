/* Supervisor login page. */
(function () {
  "use strict";

  CT.renderHeader("login");

  // Already logged in? Skip straight to home.
  CT.getAuthStatus().then(function (s) {
    if (s && s.authenticated) window.location.replace("/");
  }).catch(function () {});

  var form = document.getElementById("login-form");
  var input = document.getElementById("password");
  var btn = document.getElementById("login-btn");
  var errEl = document.getElementById("login-error");

  function showError(msg) {
    errEl.textContent = msg;
    errEl.classList.remove("hidden");
  }

  form.onsubmit = function (e) {
    e.preventDefault();
    errEl.classList.add("hidden");
    var password = input.value;
    if (!password) { input.focus(); return; }
    btn.disabled = true;
    CT.api("/api/auth/login", {
      method: "POST",
      headers: CT.jsonHeaders,
      body: JSON.stringify({ password: password }),
    })
      .then(function () {
        // Land on home, where the supervisor tools are now visible.
        window.location.href = "/";
      })
      .catch(function (err) {
        btn.disabled = false;
        input.value = "";
        input.focus();
        showError(err.message || "Login failed");
      });
  };
})();
