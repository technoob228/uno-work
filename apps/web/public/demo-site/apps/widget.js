// Applies Uno Work's look passed in the address (?uno-theme=dark&uno-accent=%23…).
(function () {
  var q = new URLSearchParams(location.search);
  var dark = q.get("uno-theme") === "dark" ||
    (!q.get("uno-theme") && matchMedia("(prefers-color-scheme: dark)").matches);
  if (dark) document.body.classList.add("dark");
  var accent = q.get("uno-accent");
  if (accent) document.body.style.setProperty("--accent", accent);
})();
