// Applies the saved light/dark choice before the page is painted, so there is
// no flash of the wrong theme. Without a saved choice the CSS follows the
// device setting. A separate file because the Content Security Policy does
// not allow inline scripts.
try {
  var t = localStorage.getItem("gl-theme");
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
} catch (e) {}
